import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { User, Role } from '../src/models/User';
import { Event, EventFormat, EventStatus } from '../src/models/Event';
import { Session, AccessControl, InviteeSource } from '../src/models/Session';
import { Invitee, InvitationStatus, RsvpStatus } from '../src/models/Invitee';
import { Invitation } from '../src/models/Invitation';
import { SystemUserAssignment } from '../src/models/SystemUserAssignment';
import { CheckIn } from '../src/models/CheckIn';
import { AuditLog } from '../src/models/AuditLog';
import { auditLogRepository } from '../src/repositories/auditLog.repository';
import { auditLogService } from '../src/services/auditLog.service';
import { sanitizeAuditMetadata } from '../src/utils/auditSanitize';
import { generateAccessToken } from '../src/utils/token';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';

// Audit entries for a request are written after the response is sent
const waitForAudit = async (query: Record<string, unknown>, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const row = await AuditLog.findOne(query).sort({ createdAt: -1 });
    if (row && row.status !== 'PENDING') return row;
    await new Promise((r) => setTimeout(r, 25));
  }
  return AuditLog.findOne(query).sort({ createdAt: -1 });
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('P0.1 — audit logging and non-destructive event closure', () => {
  let mongoServer: MongoMemoryServer;
  let orgA: any, orgB: any, admin: any, staff: any;
  let tA: string, tB: string, tAdmin: string, tStaff: string;
  let eventA: any, eventB: any, sessionA: any, inviteeA: any, rawToken: string;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([User, Event, Session, Invitee, Invitation, SystemUserAssignment, CheckIn, AuditLog].map((m: any) => m.deleteMany({})));
    const mk = async (fullName: string, email: string, role: Role) => User.create({ fullName, email, role, isActive: true });
    orgA = await mk('Org A', 'a@example.com', Role.ORGANIZER);
    orgB = await mk('Org B', 'b@example.com', Role.ORGANIZER);
    admin = await mk('Admin', 'admin@example.com', Role.ADMIN);
    staff = await mk('Staff', 'staff@example.com', Role.SYSTEM_USER);
    tA = generateAccessToken(orgA._id.toString(), orgA.role);
    tB = generateAccessToken(orgB._id.toString(), orgB.role);
    tAdmin = generateAccessToken(admin._id.toString(), admin.role);
    tStaff = generateAccessToken(staff._id.toString(), staff.role);

    const mkEvent = (organizerId: any, title: string) => Event.create({
      organizerId, title, description: 'd', categoryId: new mongoose.Types.ObjectId(), format: EventFormat.PHYSICAL,
      schedule: { start: new Date(), end: new Date(Date.now() + 3600e3) }, status: EventStatus.PUBLISHED,
      rsvp: { enabled: true, allowAllInvited: true, allowNotResponded: true, allowDeclined: false }
    });
    eventA = await mkEvent(orgA._id, 'Alpha Summit');
    eventB = await mkEvent(orgB._id, 'Beta Gala');
    sessionA = await Session.create({
      eventId: eventA._id, name: 'Main', schedule: { start: new Date(), end: new Date() },
      accessControl: AccessControl.NO_RESTRICTION, validateAgainstOtherSessions: false, inviteeSource: InviteeSource.NEW_LIST
    });
    rawToken = generateSecureToken();
    inviteeA = await Invitee.create({
      eventId: eventA._id, name: 'Guest One', email: 'g1@example.com', invitationStatus: InvitationStatus.SENT,
      rsvpStatus: RsvpStatus.ACCEPTED, qrTokenHash: hashToken(rawToken), sessionAccess: []
    });
    await SystemUserAssignment.create({ userId: staff._id, eventId: eventA._id, sessionIds: [], assignedBy: orgA._id });
  });

  afterEach(() => jest.restoreAllMocks());

  // ───────────────────────── audit logging ─────────────────────────
  describe('audit writes', () => {
    it('records a successful change with actor, role, event, tenant and request id — field names only', async () => {
      const res = await request(app).patch(`/api/v1/events/${eventA._id}`).set(auth(tA)).set('x-request-id', 'req-abc-12345').send({ title: 'Alpha Summit 2' });
      expect(res.status).toBe(200);
      expect(res.headers['x-request-id']).toBe('req-abc-12345');
      const row: any = await waitForAudit({ action: 'EVENT_UPDATE' });
      expect(row.status).toBe('SUCCESS');
      expect(String(row.actorId)).toBe(String(orgA._id));
      expect(row.actorType).toBe('ORGANIZER');
      expect(String(row.eventId)).toBe(String(eventA._id));
      expect(String(row.organizerId)).toBe(String(orgA._id));
      expect(row.requestId).toBe('req-abc-12345');
      expect(row.metadata.changedFields).toEqual(['title']);
      expect(JSON.stringify(row.metadata)).not.toContain('Alpha Summit 2');
    });

    it('records a failed operation as FAILED with the HTTP outcome', async () => {
      const res = await request(app).patch(`/api/v1/events/${eventB._id}`).set(auth(tA)).send({ title: 'Hijack' });
      expect(res.status).toBe(404);
      const row: any = await waitForAudit({ action: 'EVENT_UPDATE' });
      expect(row.status).toBe('FAILED');
      expect(row.metadata.httpStatus).toBe(404);
      expect(String(row.actorId)).toBe(String(orgA._id));
      expect((await Event.findById(eventB._id))?.title).toBe('Beta Gala');
    });

    it('never stores the QR secret or other credentials', async () => {
      const res = await request(app).post('/api/v1/checkins/scan').set(auth(tA)).send({ qrCode: rawToken, eventId: String(eventA._id) });
      expect(res.status).toBe(201);
      const row: any = await waitForAudit({ action: 'CHECKIN_SCAN' });
      expect(row.status).toBe('SUCCESS');
      const dump = JSON.stringify(row.toObject());
      expect(dump).not.toContain(rawToken);
      expect(dump).not.toContain(hashToken(rawToken));
      expect(String(row.organizerId)).toBe(String(orgA._id));
    });

    it('drops credential-like keys and truncates long text', () => {
      const out: any = sanitizeAuditMetadata({
        password: 'x', accessToken: 'y', qrCode: 'z', apiKey: 'k', tokenHash: 'h', ok: 'fine', nested: { secret: 's', note: 'a'.repeat(500) }
      });
      expect(out.password).toBeUndefined();
      expect(out.accessToken).toBeUndefined();
      expect(out.qrCode).toBeUndefined();
      expect(out.apiKey).toBeUndefined();
      expect(out.tokenHash).toBeUndefined();
      expect(out.ok).toBe('fine');
      expect(out.nested.secret).toBeUndefined();
      expect(out.nested.note.length).toBeLessThan(260);
    });

    it('refuses an entry with a missing or invalid actor', async () => {
      await expect(auditLogService.logAction({ action: 'X' })).rejects.toThrow('AUDIT_INVALID_ACTOR');
      await expect(auditLogService.logAction({ action: 'X', actorId: 'nope', actorRole: 'ORGANIZER' })).rejects.toThrow('AUDIT_INVALID_ACTOR');
      await expect(auditLogService.logAction({ action: 'X', actorId: orgA._id, actorRole: 'HACKER' })).rejects.toThrow('AUDIT_INVALID_ACTOR');
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await auditLogService.record({ action: 'X' })).toBeNull();
      expect(await AuditLog.countDocuments()).toBe(0);
    });

    it('a failed audit write does not break a non-critical request (reported on the server log)', async () => {
      const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      jest.spyOn(auditLogRepository, 'create').mockRejectedValue(new Error('db down'));
      const res = await request(app).patch(`/api/v1/events/${eventA._id}`).set(auth(tA)).send({ title: 'Still saved' });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 100));
      expect(err).toHaveBeenCalledWith('Audit write failed:', 'EVENT_UPDATE', 'db down');
    });

    it('a critical action is refused (and not performed) when its audit record cannot be written', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      jest.spyOn(auditLogRepository, 'create').mockRejectedValue(new Error('db down'));
      const res = await request(app).post(`/api/v1/events/${eventA._id}/close`).set(auth(tA));
      expect(res.status).toBe(503);
      expect((await Event.findById(eventA._id))?.status).toBe(EventStatus.PUBLISHED);
    });

    it('a critical action leaves a PENDING→SUCCESS trail, with the result recorded on completion', async () => {
      const res = await request(app).post(`/api/v1/events/${eventA._id}/close`).set(auth(tA));
      expect(res.status).toBe(200);
      const row: any = await waitForAudit({ action: 'EVENT_CLOSE' });
      expect(row.status).toBe('SUCCESS');
      expect(await AuditLog.countDocuments({ action: 'EVENT_CLOSE' })).toBe(1);
    });

    it('records staff assignment and removal, and invitee changes', async () => {
      const asg: any = await SystemUserAssignment.findOne({ eventId: eventA._id });
      const del = await request(app).delete(`/api/v1/assignments/${asg._id}`).set(auth(tA));
      expect(del.status).toBeLessThan(300);
      const row: any = await waitForAudit({ action: 'STAFF_UNASSIGN' });
      expect(String(row.eventId)).toBe(String(eventA._id));
      expect(String(row.organizerId)).toBe(String(orgA._id));

      const upd = await request(app).patch(`/api/v1/invitees/${inviteeA._id}`).set(auth(tA)).send({ name: 'Guest Uno' });
      expect(upd.status).toBe(200);
      const r2: any = await waitForAudit({ action: 'INVITEE_UPDATE' });
      expect(String(r2.eventId)).toBe(String(eventA._id));
      expect(r2.metadata.changedFields).toEqual(['name']);
    });
  });

  // ───────────────────────── audit isolation ─────────────────────────
  describe('audit read isolation', () => {
    beforeEach(async () => {
      await request(app).patch(`/api/v1/events/${eventA._id}`).set(auth(tA)).send({ title: 'A1' });
      await request(app).patch(`/api/v1/events/${eventB._id}`).set(auth(tB)).send({ title: 'B1' });
      await request(app).post('/api/v1/checkins/scan').set(auth(tStaff)).send({ qrCode: rawToken, eventId: String(eventA._id) });
      await waitForAudit({ action: 'CHECKIN_SCAN' });
      await waitForAudit({ action: 'EVENT_UPDATE', organizerId: orgB._id });
    });

    it('an organizer sees only their own tenant, including staff activity on their events', async () => {
      const res = await request(app).get('/api/v1/audit-logs').set(auth(tA));
      expect(res.status).toBe(200);
      const actions = res.body.data.map((r: any) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['EVENT_UPDATE', 'CHECKIN_SCAN']));
      for (const r of res.body.data) expect(String(r.eventId?._id)).toBe(String(eventA._id));
    });

    it('changing eventId, actorId or organizerId in the query cannot reach another organizer', async () => {
      const byEvent = await request(app).get(`/api/v1/audit-logs?eventId=${eventB._id}`).set(auth(tA));
      expect(byEvent.status).toBe(200);
      expect(byEvent.body.data).toHaveLength(0);
      const byActor = await request(app).get(`/api/v1/audit-logs?actorId=${orgB._id}`).set(auth(tA));
      expect(byActor.body.data).toHaveLength(0);
      const byTenant = await request(app).get(`/api/v1/audit-logs?organizerId=${orgB._id}`).set(auth(tA));
      expect(byTenant.body.data.every((r: any) => String(r.eventId?._id) === String(eventA._id))).toBe(true);
    });

    it('rejects malformed identifiers', async () => {
      const res = await request(app).get('/api/v1/audit-logs?eventId=$ne').set(auth(tA));
      expect(res.status).toBe(400);
    });

    it('system users cannot read audit entries; anonymous callers are refused', async () => {
      expect((await request(app).get('/api/v1/audit-logs').set(auth(tStaff))).status).toBe(403);
      expect((await request(app).get('/api/v1/audit-logs')).status).toBe(401);
    });

    it('an administrator sees the whole platform and can filter by event', async () => {
      const all = await request(app).get('/api/v1/audit-logs').set(auth(tAdmin));
      const events = new Set(all.body.data.map((r: any) => String(r.eventId?._id)));
      expect(events.has(String(eventA._id)) && events.has(String(eventB._id))).toBe(true);
      const one = await request(app).get(`/api/v1/audit-logs?eventId=${eventB._id}`).set(auth(tAdmin));
      expect(one.body.data.length).toBeGreaterThan(0);
      expect(one.body.data.every((r: any) => String(r.eventId?._id) === String(eventB._id))).toBe(true);
    });
  });

  // ───────────────────────── event closure ─────────────────────────
  describe('event closure', () => {
    const snapshot = async () => ({
      events: await Event.countDocuments({ _id: eventA._id }),
      sessions: await Session.countDocuments({ eventId: eventA._id }),
      invitees: await Invitee.countDocuments({ eventId: eventA._id }),
      invitations: await Invitation.countDocuments({ eventId: eventA._id }),
      checkIns: await CheckIn.countDocuments({ eventId: eventA._id }),
      assignments: await SystemUserAssignment.countDocuments({ eventId: eventA._id })
    });

    it('closing keeps every record and moves the event to COMPLETED', async () => {
      await request(app).post('/api/v1/checkins/scan').set(auth(tA)).send({ qrCode: rawToken, eventId: String(eventA._id) });
      await Invitation.create({ eventId: eventA._id, inviteeId: inviteeA._id, channel: 'EMAIL', status: 'SENT', tokenHash: hashToken('x') } as any).catch(() => undefined);
      const before = await snapshot();
      expect(before.checkIns).toBe(1);

      const res = await request(app).post(`/api/v1/events/${eventA._id}/close`).set(auth(tA));
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('COMPLETED');
      expect(await snapshot()).toEqual(before);

      const ev: any = await Event.findById(eventA._id);
      expect(ev.status).toBe(EventStatus.COMPLETED);
      expect(ev.closedAt).toBeInstanceOf(Date);
      expect(String(ev.closedBy)).toBe(String(orgA._id));
      expect(ev.operationalDataCleared).not.toBe(true);

      // still readable through the API
      const invitees = await request(app).get(`/api/v1/events/${eventA._id}/invitees`).set(auth(tA));
      expect(invitees.status).toBe(200);
      expect(JSON.stringify(invitees.body)).toContain('Guest One');
      const report = await request(app).get(`/api/v1/reports/events/${eventA._id}`).set(auth(tA));
      expect(report.status).toBe(200);
      expect(JSON.stringify(report.body)).toContain('1');
      const checkins = await request(app).get(`/api/v1/events/${eventA._id}/checkins`).set(auth(tA));
      expect(checkins.status).toBe(200);
      const audit = await request(app).get(`/api/v1/audit-logs?eventId=${eventA._id}`).set(auth(tA));
      expect(audit.body.data.map((r: any) => r.action)).toContain('EVENT_CLOSE');
    });

    it('an administrator can close any event', async () => {
      const res = await request(app).post(`/api/v1/events/${eventB._id}/close`).set(auth(tAdmin));
      expect(res.status).toBe(200);
    });

    it('rejects invalid transitions on the server', async () => {
      expect((await request(app).post(`/api/v1/events/${eventA._id}/close`).set(auth(tA))).status).toBe(200);
      const again = await request(app).post(`/api/v1/events/${eventA._id}/close`).set(auth(tA));
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('INVALID_TRANSITION');

      const cancelCompleted = await request(app).delete(`/api/v1/events/${eventA._id}`).set(auth(tA));
      expect(cancelCompleted.status).toBe(409);
      expect((await Event.findById(eventA._id))?.status).toBe(EventStatus.COMPLETED);

      await Event.updateOne({ _id: eventB._id }, { status: EventStatus.CANCELLED });
      expect((await request(app).post(`/api/v1/events/${eventB._id}/close`).set(auth(tB))).status).toBe(409);
    });

    it('status cannot be set through the ordinary update endpoint', async () => {
      const res = await request(app).patch(`/api/v1/events/${eventA._id}`).set(auth(tA)).send({ status: 'COMPLETED' });
      expect(res.status).toBeLessThan(500);
      expect((await Event.findById(eventA._id))?.status).toBe(EventStatus.PUBLISHED);
    });

    it('a closed event can no longer be edited', async () => {
      await request(app).post(`/api/v1/events/${eventA._id}/close`).set(auth(tA));
      const res = await request(app).patch(`/api/v1/events/${eventA._id}`).set(auth(tA)).send({ title: 'Rewrite history' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EVENT_CLOSED');
    });

    it('only an admin or the owning organizer may close', async () => {
      expect((await request(app).post(`/api/v1/events/${eventA._id}/close`).set(auth(tB))).status).toBe(404);
      expect((await request(app).post(`/api/v1/events/${eventA._id}/close`).set(auth(tStaff))).status).toBe(403);
      expect((await request(app).post(`/api/v1/events/${eventA._id}/close`)).status).toBe(401);
      expect((await Event.findById(eventA._id))?.status).toBe(EventStatus.PUBLISHED);
    });
  });

  // ───────────────────────── permanent deletion ─────────────────────────
  describe('permanent deletion is a separate, guarded operation', () => {
    it('is not reachable through close, and needs an event that is over', async () => {
      const before = await Invitee.countDocuments({ eventId: eventA._id });
      const open = await request(app).post(`/api/v1/events/${eventA._id}/cleanup`).set(auth(tAdmin)).send({ confirmTitle: 'Alpha Summit' });
      expect(open.status).toBe(409);
      expect(open.body.code).toBe('EVENT_NOT_CLOSED');
      await request(app).post(`/api/v1/events/${eventA._id}/close`).set(auth(tA));
      expect(await Invitee.countDocuments({ eventId: eventA._id })).toBe(before);
    });

    it('is available once the event\'s end time has passed, without anyone closing it', async () => {
      await Event.updateOne({ _id: eventA._id }, { 'schedule.end': new Date(Date.now() - 60_000) });
      const ok = await request(app).post(`/api/v1/events/${eventA._id}/cleanup`).set(auth(tAdmin)).send({ confirmTitle: 'Alpha Summit' });
      expect(ok.status).toBe(200);
      expect(await Invitee.countDocuments({ eventId: eventA._id })).toBe(0);
    });

    it('is admin-only, needs the exact event title, and leaves an audit record', async () => {
      await request(app).post(`/api/v1/events/${eventA._id}/close`).set(auth(tA));
      expect((await request(app).post(`/api/v1/events/${eventA._id}/cleanup`).set(auth(tA)).send({ confirmTitle: 'Alpha Summit' })).status).toBe(403);
      const none = await request(app).post(`/api/v1/events/${eventA._id}/cleanup`).set(auth(tAdmin));
      expect(none.status).toBe(400);
      expect(none.body.code).toBe('CONFIRMATION_REQUIRED');
      expect((await request(app).post(`/api/v1/events/${eventA._id}/cleanup`).set(auth(tAdmin)).send({ confirmTitle: 'wrong' })).status).toBe(400);
      expect(await Invitee.countDocuments({ eventId: eventA._id })).toBe(1);

      const ok = await request(app).post(`/api/v1/events/${eventA._id}/cleanup`).set(auth(tAdmin)).send({ confirmTitle: 'Alpha Summit' });
      expect(ok.status).toBe(200);
      expect(await Invitee.countDocuments({ eventId: eventA._id })).toBe(0);
      expect(await Session.countDocuments({ eventId: eventA._id })).toBe(0);
      const ev: any = await Event.findById(eventA._id);
      expect(ev).toBeTruthy();
      expect(ev.status).toBe(EventStatus.COMPLETED);
      expect(ev.operationalDataCleared).toBe(true);

      const row: any = await waitForAudit({ action: 'EVENT_PURGE' });
      expect(row.status).toBe('SUCCESS');
      expect(String(row.actorId)).toBe(String(admin._id));
      expect(row.metadata.cleanedCounts.invitees).toBe(1);
      // the organizer can still see that it happened
      const audit = await request(app).get(`/api/v1/audit-logs?eventId=${eventA._id}`).set(auth(tA));
      expect(audit.body.data.map((r: any) => r.action)).toEqual(expect.arrayContaining(['EVENT_CLOSE', 'EVENT_PURGE']));
    });
  });
});
