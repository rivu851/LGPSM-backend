import mongoose from 'mongoose';
import archiver from 'archiver';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import type { Response } from 'express';
import { Event } from '../models/Event';
import { Invitee } from '../models/Invitee';
import { Role } from '../models/User';
import { generateSecureToken, hashToken } from '../utils/invitation.util';
import { encryptToken } from '../utils/tokenCipher';
import { readAdmissionToken } from '../utils/credentialTokens';
import { invitationService, assertEventCanIssue } from './invitation.service';
import { credentialService } from './credential.service';

/** Most guests one zip holds. The organizer chooses a smaller number in the download window. */
export const MAX_PER_ZIP = 100;

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

function guestFilter(eventId: string, inviteeIds?: string[]) {
  const filter: any = { eventId };
  if (inviteeIds && inviteeIds.length) {
    const ids = inviteeIds.filter((i) => mongoose.Types.ObjectId.isValid(i));
    filter._id = { $in: ids };
  }
  return filter;
}

const safeName = (s: string) => String(s || 'guest').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'guest';

export const cardDownloadService = {
  /** How many guests the cards are for and how many zip files that makes at `perZip` guests each. */
  async plan(actor: Actor, eventId: string, perZip: number, inviteeIds?: string[]) {
    await loadEvent(actor, eventId);
    const limit = Math.min(Math.max(Math.floor(perZip) || MAX_PER_ZIP, 1), MAX_PER_ZIP);
    const total = await Invitee.countDocuments(guestFilter(eventId, inviteeIds));
    return { total, perZip: limit, zips: Math.ceil(total / limit) };
  },

  /**
   * Streams ONE zip: part `part` (1-based) of the guests, `perZip` per part, in a stable order (the order they were added). Each guest
   * has their own PDF holding their personal card at print quality. Part 3 of 10 is always the same guests, so the parts can be
   * fetched one after another to download every card of a large event.
   */
  async streamZip(actor: Actor, eventId: string, opts: { part: number; perZip: number; inviteeIds?: string[] }, res: Response) {
    const event = await loadEvent(actor, eventId);
    const limit = Math.min(Math.max(Math.floor(opts.perZip) || MAX_PER_ZIP, 1), MAX_PER_ZIP);
    const part = Math.max(Math.floor(opts.part) || 1, 1);
    const filter = guestFilter(eventId, opts.inviteeIds);
    const total = await Invitee.countDocuments(filter);
    const zips = Math.max(Math.ceil(total / limit), 1);
    if (part > zips) throw fail(400, 'That part does not exist.');
    const guests = await Invitee.find(filter).select('+qrTokenCipher').sort({ createdAt: 1, _id: 1 }).skip((part - 1) * limit).limit(limit);

    const base = `${safeName(event.title)}-cards-${part}-of-${zips}`;
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.zip"`);
    res.setHeader('X-Zip-Part', String(part));
    res.setHeader('X-Zip-Count', String(zips));
    res.setHeader('X-Guests-Total', String(total));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Zip-Part, X-Zip-Count, X-Guests-Total');

    const zip = archiver('zip', { store: true }); // the PDFs are already compressed
    zip.on('warning', (e: Error) => console.warn('Card zip warning:', e.message));
    zip.pipe(res);
    const skipped: string[] = [];
    const firstIndex = (part - 1) * limit;

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
