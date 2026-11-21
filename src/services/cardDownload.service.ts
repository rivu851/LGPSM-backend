import mongoose from 'mongoose';
import archiver from 'archiver';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import type { Response } from 'express';
import { Event } from '../models/Event';
import { Invitee } from '../models/Invitee';
import { Session } from '../models/Session';
import { CardDownloadPlan } from '../models/CardDownloadPlan';
import { Role } from '../models/User';
import { generateSecureToken, hashToken } from '../utils/invitation.util';
import { encryptToken } from '../utils/tokenCipher';
import { readAdmissionToken } from '../utils/credentialTokens';
import { invitationService, assertEventCanIssue } from './invitation.service';
import { credentialService } from './credential.service';

// A card is drawn 1536 x 2048 px; on a 6 x 8 inch page that is 256 dpi, with the QR code and text kept sharp for print.
const PAGE_W_PT = 6 * 72;
const PAGE_H_PT = 8 * 72;
const RENDER_AT_A_TIME = 3;

const fail = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, code, message });
type Actor = { userId: string; role: string };

async function loadEvent(actor: Actor, eventId: string) {
  if (!mongoose.Types.ObjectId.isValid(eventId)) throw fail(400, 'Invalid event id');
  const event: any = actor.role === Role.ADMIN ? await Event.findById(eventId) : await Event.findOne({ _id: eventId, organizerId: actor.userId });
  if (!event) throw fail(404, 'Event not found or inaccessible');
  if (event.invitationType !== 'PRINT' && event.invitationType !== 'BOTH') {
    throw fail(409, 'This event is set to digital invitations only, so there are no printable cards to download.', 'NOT_A_PRINT_EVENT');
  }
  // printing issues a guest's entry pass like sending does, so a cancelled or finished event cannot do it either
  try { assertEventCanIssue(event); } catch (e: any) { throw fail(409, e?.message === 'EVENT_CANCELLED' ? 'This event is cancelled.' : 'This event is over, so cards can no longer be produced.', 'EVENT_CLOSED'); }
  return event;
}

/** Most guests one zip holds. The split is the system's: nobody chooses it, so a large selection can never become a flood of tiny zips. */
export const MAX_PER_ZIP = 100;
const PLAN_MINUTES = 60;

/**
 * How many guests go in each zip: as few zips as the 100 limit allows, filled evenly (1000 guests: 10 zips of 100; 150: two of 75;
 * 250: three of 84, 83 and 83), never a full zip followed by a small leftover.
 */
export function zipSizes(total: number): number[] {
  if (total <= 0) return [];
  const zips = Math.ceil(total / MAX_PER_ZIP);
  const base = Math.floor(total / zips);
  const extra = total % zips;
  return Array.from({ length: zips }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * The zip's name: "Event name_Session name.zip", or just "Event name.zip" when the cards are not for one particular session. A selection
 * that needs several zips numbers them ("Event name_Session name_1.zip", "_2" ...). The names are the person's own words, with only the
 * characters a file name cannot hold taken out.
 */
const fileSafe = (s: string) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
export function zipFileNames(eventTitle: string, sessionName: string | null, zips: number): string[] {
  const base = [fileSafe(eventTitle) || 'Event', sessionName ? fileSafe(sessionName) : ''].filter(Boolean).join('_');
  return Array.from({ length: zips }, (_, i) => `${base}${zips > 1 ? `_${i + 1}` : ''}.zip`);
}
const asciiName = (n: string) => n.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/"/g, '') || 'cards.zip';

const safeName = (s: string) => String(s || 'guest').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'guest';

export const cardDownloadService = {
  /** Keeps the chosen guests under a plan id and says how many zip files they make. Only guests of this event are kept. */
  async plan(actor: Actor, eventId: string, inviteeIds: string[], sessionId?: string | null) {
    const event = await loadEvent(actor, eventId);
    // the session the list was filtered to (it names the zips); it must be one of this event's
    let session: any = null;
    if (sessionId) {
      session = mongoose.Types.ObjectId.isValid(sessionId) ? await Session.findOne({ _id: sessionId, eventId }).select('name').lean() : null;
      if (!session) throw fail(400, 'That session is not part of this event.');
    }
    const ids = [...new Set(inviteeIds.filter((i) => mongoose.Types.ObjectId.isValid(i)))];
    if (ids.length === 0) throw fail(400, 'Select at least one guest to download cards for.', 'NO_GUESTS_SELECTED');
    const found = await Invitee.find({ eventId, _id: { $in: ids } }).select('_id').sort({ createdAt: 1, _id: 1 }).lean();
    if (found.length === 0) throw fail(400, 'None of the selected guests are on this event.', 'NO_GUESTS_SELECTED');
    const plan = await CardDownloadPlan.create({
      eventId, userId: actor.userId, inviteeIds: found.map((g: any) => g._id), sessionId: session ? session._id : null, expiresAt: new Date(Date.now() + PLAN_MINUTES * 60 * 1000)
    });
    const sizes = zipSizes(found.length);
    return { planId: String(plan._id), total: found.length, zips: sizes.length, sizes, fileNames: zipFileNames(event.title, session ? session.name : null, sizes.length) };
  },

  /**
   * Streams ONE zip: part `part` (1-based) of a plan. Each guest has their own PDF holding their personal card at print quality.
   * Part 3 of 10 is always the same guests, so the parts can be fetched one after another to download every card.
   */
  async streamZip(actor: Actor, eventId: string, opts: { planId: string; part: number }, res: Response) {
    const event = await loadEvent(actor, eventId);
    const plan: any = mongoose.Types.ObjectId.isValid(opts.planId) ? await CardDownloadPlan.findOne({ _id: opts.planId, eventId, userId: actor.userId }).lean() : null;
    if (!plan) throw fail(404, 'This download has expired. Please start it again.', 'PLAN_EXPIRED');
    const sizes = zipSizes(plan.inviteeIds.length);
    const part = Math.floor(opts.part) || 1;
    if (part < 1 || part > sizes.length) throw fail(400, 'That part does not exist.');
    const zips = sizes.length;
    const total = plan.inviteeIds.length;
    const offset = sizes.slice(0, part - 1).reduce((a, b) => a + b, 0);
    const wanted = plan.inviteeIds.slice(offset, offset + sizes[part - 1]);
    const order = new Map<string, number>(wanted.map((id: any, i: number) => [String(id), i]));
    const guests = (await Invitee.find({ eventId, _id: { $in: wanted } }).select('+qrTokenCipher')).sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));
    const firstIndex = offset;

    const sess: any = plan.sessionId ? await Session.findOne({ _id: plan.sessionId, eventId }).select('name').lean() : null;
    const fileName = zipFileNames(event.title, sess ? sess.name : null, zips)[part - 1];
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('X-Zip-Part', String(part));
    res.setHeader('X-Zip-Count', String(zips));
    res.setHeader('X-Guests-Total', String(total));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Zip-Part, X-Zip-Count, X-Guests-Total');

    const zip = archiver('zip', { store: true }); // the PDFs are already compressed
    zip.on('warning', (e: Error) => console.warn('Card zip warning:', e.message));
    zip.pipe(res);
    const skipped: string[] = [];

    // the pass printed on a card is the guest's entry credential: a guest who has none yet gets one now (nothing is sent to them).
    const passFor = async (g: any): Promise<string | null> => {
      const existing = readAdmissionToken(g);
      if (existing) return existing;
      // a pass exists but its secret cannot be recovered (an old invitation): never replace it, that would break the card they already hold
      if (g.qrTokenHash) return null;
      const raw = generateSecureToken();
      const upd = await Invitee.updateOne({ _id: g._id, qrTokenHash: { $in: [null, undefined, ''] } }, { $set: { qrTokenHash: hashToken(raw), qrTokenCipher: encryptToken(raw) } });
      if (upd.modifiedCount !== 1) return readAdmissionToken((await Invitee.findById(g._id).select('+qrTokenCipher')) as any);
      g.qrTokenHash = hashToken(raw);
      g.qrTokenCipher = encryptToken(raw);
      await credentialService.recordIssuance({ invitee: g, tokenHash: hashToken(raw), source: 'SEND', actorId: actor.userId, actorRole: actor.role, organizerId: event.organizerId })
        .catch((e) => console.error('Credential history not recorded:', e?.message));
      return raw;
    };

    const makePdf = async (g: any): Promise<Buffer | null> => {
      const token = await passFor(g);
      if (!token) return null;
      const png = await invitationService.renderPassCard(event, g, token);
      const jpg = await sharp(png).flatten({ background: '#ffffff' }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
      const pdf = await PDFDocument.create();
      pdf.setTitle(`${event.title}: ${g.name}`);
      pdf.setCreator('EventQRapp');
      const img = await pdf.embedJpg(jpg);
      const page = pdf.addPage([PAGE_W_PT, PAGE_H_PT]);
      page.drawImage(img, { x: 0, y: 0, width: PAGE_W_PT, height: PAGE_H_PT });
      return Buffer.from(await pdf.save());
    };

    try {
      for (let i = 0; i < guests.length; i += RENDER_AT_A_TIME) {
        const slice = guests.slice(i, i + RENDER_AT_A_TIME);
        const pdfs = await Promise.all(slice.map((g) => makePdf(g).catch((e) => { console.error('Card not drawn:', e?.message); return null; })));
        slice.forEach((g, k) => {
          const pdf = pdfs[k];
          if (!pdf) { skipped.push(g.name); return; }
          zip.append(pdf, { name: `${String(firstIndex + i + k + 1).padStart(4, '0')}-${safeName(g.name)}.pdf` });
        });
      }
      if (skipped.length) {
        zip.append(`These guests have no card in this file:\n${skipped.map((n) => `- ${n}`).join('\n')}\n\nA guest whose earlier invitation cannot be redrawn keeps the card they already have; the others could not be drawn (try again).\n`, { name: '_not-included.txt' });
      }
      await zip.finalize();
    } catch (err) {
      zip.abort();
      throw err;
    }
  }
};
