import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Event, EventStatus } from '../src/models/Event';
import { Invitee } from '../src/models/Invitee';
import { Invitation } from '../src/models/Invitation';
import { CredentialEvent } from '../src/models/CredentialEvent';
import { User, Role } from '../src/models/User';
import { credentialInventory } from '../src/migrations/credentialInventory';
import { hashToken, generateSecureToken } from '../src/utils/invitation.util';
import { encryptToken } from '../src/utils/tokenCipher';

jest.setTimeout(60_000);
let mongo: MongoMemoryServer; let org: any;
const HOUR = 3600e3;

beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); org = await User.create({ fullName: 'Org', email: 'org.inv@x.com', role: Role.ORGANIZER, isActive: true }); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('legacy credential inventory (read-only)', () => {
  const mkEvent = (title: string, extra: Record<string, unknown> = {}) => Event.create({ organizerId: org._id, title, description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', status: EventStatus.PUBLISHED, schedule: { start: new Date(Date.now() - HOUR), end: new Date(Date.now() + 4 * HOUR) }, ...extra } as any);
  let n = 0;
  const guest = async (ev: any, extra: Record<string, unknown> = {}, o: { invitation?: boolean; events?: string[] } = {}) => {
    n++;
    const g: any = await Invitee.create({ eventId: ev._id, name: `Guest ${n}`, email: `guest${n}@secret-domain.example`, mobile: `98700${String(10000 + n)}`, invitationStatus: 'SENT', rsvpStatus: 'PENDING', sessionAccess: [], ...extra });
    if (o.invitation !== false && (extra as any).qrTokenHash) await Invitation.create({ eventId: ev._id, inviteeId: g._id, tokenHash: String((extra as any).qrTokenHash), channel: 'EMAIL', status: 'SENT', emailStatus: 'SENT' } as any);
    for (const h of o.events || []) await CredentialEvent.create({ eventId: ev._id, inviteeId: g._id, organizerId: org._id, type: 'ISSUED', version: 1, source: 'SEND', tokenHash: h });
    return g;
  };
  const shared = () => { const t = generateSecureToken(); return { qrTokenHash: hashToken(t), qrTokenCipher: encryptToken(t) }; };

  it('classifies every active guest, per event, from the records alone', async () => {
    const A = await mkEvent('Summit'); const B = await mkEvent('Called Off', { status: EventStatus.CANCELLED });
    await guest(A, shared());                                                              // 1 legacy, can be re-sent
    await guest(A, { qrTokenHash: hashToken(generateSecureToken()) });                     // 2 legacy, no recoverable copy -> link would change
    await guest(A, { ...shared(), credentialRevokedAt: new Date() });                      // 3 legacy, revoked
    await guest(A, { ...shared(), email: undefined, mobile: undefined });                  // 4 legacy, nobody to tell
    await guest(A, shared(), { invitation: false });                                       // 5 legacy, no invitation record to re-send
    await guest(A, { ...shared(), invitationTokenHash: hashToken(generateSecureToken()), invitationTokenCipher: encryptToken(generateSecureToken()) }); // 6 separated, native
    const oldShared = generateSecureToken();
    await guest(A, { ...shared(), invitationTokenHash: hashToken(oldShared) }, { events: [hashToken(oldShared)] });   // 7 separated, migrated (the old token is its link now)
    await guest(A, { invitationStatus: 'PENDING' });                                       // 8 not issued
    await guest(A, {});                                                                    // 9 undetermined: marked sent, no pass
    const same = hashToken(generateSecureToken());
    await guest(A, { qrTokenHash: same, invitationTokenHash: same });                      // 10 undetermined: one secret in both places
    await guest(A, { ...shared(), archivedAt: new Date() });                               // 11 set aside: not counted
    await guest(B, shared());                                                              // event cancelled: legacy, expired, blocked

    const before = JSON.stringify(await Invitee.collection.find({}).sort({ _id: 1 }).toArray());
    const inv = await credentialInventory();
    expect(JSON.stringify(await Invitee.collection.find({}).sort({ _id: 1 }).toArray())).toBe(before); // read-only

    const a = inv.events.find((e) => e.title === 'Summit')!;
    expect(a).toMatchObject({ activeGuests: 10, notIssued: 1, legacyShared: 5, separatedNative: 1, separatedMigrated: 1, undetermined: 2 });
    expect(a.passState).toEqual({ active: 6, revoked: 1, expired: 0 });
    expect(a.legacyMigration).toEqual({ resendable: 1, blocked: { eventNotPublished: 0, revoked: 1, noContact: 1, noInvitationRecord: 1, linkWouldChange: 1 } });
    const b = inv.events.find((e) => e.title === 'Called Off')!;
    expect(b).toMatchObject({ status: 'CANCELLED', legacyShared: 1 });
    expect(b.passState.expired).toBe(1);
    expect(b.legacyMigration.blocked.eventNotPublished).toBe(1);
    expect(inv.totals).toMatchObject({ activeGuests: 11, legacyShared: 6, separatedNative: 1, separatedMigrated: 1, undetermined: 2, notIssued: 1 });
    expect(inv.totals.legacyMigration.resendable).toBe(1);
  });

  it('reports only counts: no token, hash, encrypted copy, name, email or phone number', async () => {
    const json = JSON.stringify(await credentialInventory());
    expect(json).not.toMatch(/[a-f0-9]{40,}/i);          // no hash or token
    expect(json).not.toMatch(/@secret-domain|guest\d+@|98700\d{5}/);
    expect(json).not.toMatch(/Guest \d+|cipher|qrToken|invitationToken|tokenHash/i);
  });
});
