"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardDownloadService = exports.MAX_PER_ZIP = exports.fail = void 0;
exports.loadEvent = loadEvent;
exports.maxPerZip = maxPerZip;
exports.zipSizes = zipSizes;
exports.zipFileNames = zipFileNames;
exports.writePartZip = writePartZip;
const mongoose_1 = __importDefault(require("mongoose"));
const archiver_1 = __importDefault(require("archiver"));
const sharp_1 = __importDefault(require("sharp"));
const pdf_lib_1 = require("pdf-lib");
const Event_1 = require("../models/Event");
const Invitee_1 = require("../models/Invitee");
const Session_1 = require("../models/Session");
const CardDownloadPlan_1 = require("../models/CardDownloadPlan");
const User_1 = require("../models/User");
const invitation_util_1 = require("../utils/invitation.util");
const tokenCipher_1 = require("../utils/tokenCipher");
const credentialTokens_1 = require("../utils/credentialTokens");
const invitation_service_1 = require("./invitation.service");
const credential_service_1 = require("./credential.service");
// The page takes the card's own shape and pixel size (never a fixed paper size, which would stretch it): 1 px = 72/256 pt, i.e. 256 dpi,
// so the QR code and text stay sharp for print.
const PT_PER_PX = 72 / 256;
const RENDER_AT_A_TIME = 3;
const fail = (statusCode, message, code) => Object.assign(new Error(message), { statusCode, code, message });
exports.fail = fail;
async function loadEvent(actor, eventId) {
    if (!mongoose_1.default.Types.ObjectId.isValid(eventId))
        throw (0, exports.fail)(400, 'Invalid event id');
    const event = actor.role === User_1.Role.ADMIN ? await Event_1.Event.findById(eventId) : await Event_1.Event.findOne({ _id: eventId, organizerId: actor.userId });
    if (!event)
        throw (0, exports.fail)(404, 'Event not found or inaccessible');
    if (event.invitationType !== 'PRINT' && event.invitationType !== 'BOTH') {
        throw (0, exports.fail)(409, 'This event is set to digital invitations only, so there are no printable cards to download.', 'NOT_A_PRINT_EVENT');
    }
    // printing issues a guest's entry pass like sending does, so a cancelled or finished event cannot do it either
    try {
        (0, invitation_service_1.assertEventCanIssue)(event);
    }
    catch (e) {
        throw (0, exports.fail)(409, e?.message === 'EVENT_CANCELLED' ? 'This event is cancelled.' : 'This event is over, so cards can no longer be produced.', 'EVENT_CLOSED');
    }
    return event;
}
/** Most guests one zip holds. The split is the system's: nobody chooses it, so a large selection can never become a flood of tiny zips. */
exports.MAX_PER_ZIP = 100;
/** The limit in force: CARD_ZIP_MAX_GUESTS (1 to 100) lets a slow server use smaller zips, which are quicker to prepare one by one */
function maxPerZip() {
    const n = Math.floor(Number(process.env.CARD_ZIP_MAX_GUESTS));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, exports.MAX_PER_ZIP) : exports.MAX_PER_ZIP;
}
const PLAN_MINUTES = 60;
/**
 * How many guests go in each zip: as few zips as the 100 limit allows, filled evenly (1000 guests: 10 zips of 100; 150: two of 75;
 * 250: three of 84, 83 and 83), never a full zip followed by a small leftover.
 */
function zipSizes(total) {
    if (total <= 0)
        return [];
    const zips = Math.ceil(total / maxPerZip());
    const base = Math.floor(total / zips);
    const extra = total % zips;
    return Array.from({ length: zips }, (_, i) => base + (i < extra ? 1 : 0));
}
/**
 * The zip's name: "Event name_Session name.zip", or just "Event name.zip" when the cards are not for one particular session. A selection
 * that needs several zips numbers them ("Event name_Session name_1.zip", "_2" ...). The names are the person's own words, with only the
 * characters a file name cannot hold taken out.
 */
const fileSafe = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
function zipFileNames(eventTitle, sessionName, zips) {
    const base = [fileSafe(eventTitle) || 'Event', sessionName ? fileSafe(sessionName) : ''].filter(Boolean).join('_');
    return Array.from({ length: zips }, (_, i) => `${base}${zips > 1 ? `_${i + 1}` : ''}.zip`);
}
const asciiName = (n) => n.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/"/g, '') || 'cards.zip';
const safeName = (s) => String(s || 'guest').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'guest';
/**
 * Writes ONE zip of printable PDFs (one per guest, in order) to `out`. A guest with no pass yet gets one (nothing is sent to them).
 * `onGuest` is called after each guest so a caller can show progress.
 */
async function writePartZip(actor, event, guests, firstIndex, out, onGuest) {
    const zip = (0, archiver_1.default)('zip', { store: true }); // the PDFs are already compressed
    zip.on('warning', (e) => console.warn('Card zip warning:', e.message));
    const written = new Promise((resolve, reject) => { out.on('finish', () => resolve()); out.on('error', reject); });
    zip.pipe(out);
    const skipped = [];
    // the pass printed on a card is the guest's entry credential: a guest who has none yet gets one now (nothing is sent to them).
    const passFor = async (g) => {
        const existing = (0, credentialTokens_1.readAdmissionToken)(g);
        if (existing)
            return existing;
        // a pass exists but its secret cannot be recovered (an old invitation): never replace it, that would break the card they already hold
        if (g.qrTokenHash)
            return null;
        const raw = (0, invitation_util_1.generateSecureToken)();
        const upd = await Invitee_1.Invitee.updateOne({ _id: g._id, qrTokenHash: { $in: [null, undefined, ''] } }, { $set: { qrTokenHash: (0, invitation_util_1.hashToken)(raw), qrTokenCipher: (0, tokenCipher_1.encryptToken)(raw) } });
        if (upd.modifiedCount !== 1)
            return (0, credentialTokens_1.readAdmissionToken)((await Invitee_1.Invitee.findById(g._id).select('+qrTokenCipher')));
        g.qrTokenHash = (0, invitation_util_1.hashToken)(raw);
        g.qrTokenCipher = (0, tokenCipher_1.encryptToken)(raw);
        await credential_service_1.credentialService.recordIssuance({ invitee: g, tokenHash: (0, invitation_util_1.hashToken)(raw), source: 'SEND', actorId: actor.userId, actorRole: actor.role, organizerId: event.organizerId })
            .catch((e) => console.error('Credential history not recorded:', e?.message));
        return raw;
    };
    const makePdf = async (g) => {
        const token = await passFor(g);
        if (!token)
            return null;
        const png = await invitation_service_1.invitationService.renderPassCard(event, g, token);
        const flat = (0, sharp_1.default)(png).flatten({ background: '#ffffff' });
        const meta = await (0, sharp_1.default)(png).metadata();
        const pxW = meta.width || 1536;
        const pxH = meta.height || 2048;
        const jpg = await flat.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
        const pdf = await pdf_lib_1.PDFDocument.create();
        pdf.setTitle(`${event.title}: ${g.name}`);
        pdf.setCreator('EventQRapp');
        const img = await pdf.embedJpg(jpg);
        const pageW = pxW * PT_PER_PX;
        const pageH = pxH * PT_PER_PX;
        const page = pdf.addPage([pageW, pageH]);
        page.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });
        return Buffer.from(await pdf.save());
    };
    // Making the cards locks the event (like sending an invitation): the guests will hold cards made from its details.
    // Marked before the first card is drawn, and without touching updatedAt so an open editor is not told the event changed.
    if (!event.cardsDownloadedAt) {
        await Event_1.Event.updateOne({ _id: event._id, cardsDownloadedAt: { $in: [null, undefined] } }, { $set: { cardsDownloadedAt: new Date() } }, { timestamps: false });
        event.cardsDownloadedAt = new Date();
    }
    try {
        for (let i = 0; i < guests.length; i += RENDER_AT_A_TIME) {
            const slice = guests.slice(i, i + RENDER_AT_A_TIME);
            const pdfs = await Promise.all(slice.map((g) => makePdf(g).catch((e) => { console.error('Card not drawn:', e?.message); return null; })));
            slice.forEach((g, k) => {
                const pdf = pdfs[k];
                if (!pdf) {
                    skipped.push(g.name);
                    return;
                }
                zip.append(pdf, { name: `${String(firstIndex + i + k + 1).padStart(4, '0')}-${safeName(g.name)}.pdf` });
            });
            slice.forEach(() => onGuest?.());
        }
        if (skipped.length) {
            zip.append(`These guests have no card in this file:\n${skipped.map((n) => `- ${n}`).join('\n')}\n\nA guest whose earlier invitation cannot be redrawn keeps the card they already have; the others could not be drawn (try again).\n`, { name: '_not-included.txt' });
        }
        await zip.finalize();
        await written; // everything has reached `out` (a file is complete only now)
    }
    catch (err) {
        zip.abort();
        throw err;
    }
}
exports.cardDownloadService = {
    /** Keeps the chosen guests under a plan id and says how many zip files they make. Only guests of this event are kept. */
    async plan(actor, eventId, inviteeIds, sessionId) {
        const event = await loadEvent(actor, eventId);
        // the session the list was filtered to (it names the zips); it must be one of this event's
        let session = null;
        if (sessionId) {
            session = mongoose_1.default.Types.ObjectId.isValid(sessionId) ? await Session_1.Session.findOne({ _id: sessionId, eventId }).select('name').lean() : null;
            if (!session)
                throw (0, exports.fail)(400, 'That session is not part of this event.');
        }
        const ids = [...new Set(inviteeIds.filter((i) => mongoose_1.default.Types.ObjectId.isValid(i)))];
        if (ids.length === 0)
            throw (0, exports.fail)(400, 'Select at least one guest to download cards for.', 'NO_GUESTS_SELECTED');
        const found = await Invitee_1.Invitee.find({ eventId, _id: { $in: ids } }).select('_id').sort({ createdAt: 1, _id: 1 }).lean();
        if (found.length === 0)
            throw (0, exports.fail)(400, 'None of the selected guests are on this event.', 'NO_GUESTS_SELECTED');
        const plan = await CardDownloadPlan_1.CardDownloadPlan.create({
            eventId, userId: actor.userId, inviteeIds: found.map((g) => g._id), sessionId: session ? session._id : null, expiresAt: new Date(Date.now() + PLAN_MINUTES * 60 * 1000)
        });
        const sizes = zipSizes(found.length);
        const outer = zipFileNames(event.title, session ? session.name : null, 1)[0];
        return { planId: String(plan._id), total: found.length, zips: sizes.length, sizes, fileNames: zipFileNames(event.title, session ? session.name : null, sizes.length), /** the one file the person downloads */ fileName: outer, /** true when it holds smaller zips (more than 100 guests); false when it holds the PDFs directly */ nested: sizes.length > 1 };
    },
    /**
     * Streams ONE zip: part `part` (1-based) of a plan. Each guest has their own PDF holding their personal card at print quality.
     * Part 3 of 10 is always the same guests, so the parts can be fetched one after another to download every card.
     */
    async streamZip(actor, eventId, opts, res) {
        const event = await loadEvent(actor, eventId);
        const plan = mongoose_1.default.Types.ObjectId.isValid(opts.planId) ? await CardDownloadPlan_1.CardDownloadPlan.findOne({ _id: opts.planId, eventId, userId: actor.userId }).lean() : null;
        if (!plan)
            throw (0, exports.fail)(404, 'This download has expired. Please start it again.', 'PLAN_EXPIRED');
        const sizes = zipSizes(plan.inviteeIds.length);
        const part = Math.floor(opts.part) || 1;
        if (part < 1 || part > sizes.length)
            throw (0, exports.fail)(400, 'That part does not exist.');
        const zips = sizes.length;
        const total = plan.inviteeIds.length;
        const offset = sizes.slice(0, part - 1).reduce((a, b) => a + b, 0);
        const wanted = plan.inviteeIds.slice(offset, offset + sizes[part - 1]);
        const order = new Map(wanted.map((id, i) => [String(id), i]));
        const guests = (await Invitee_1.Invitee.find({ eventId, _id: { $in: wanted } }).select('+qrTokenCipher')).sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));
        const firstIndex = offset;
        const sess = plan.sessionId ? await Session_1.Session.findOne({ _id: plan.sessionId, eventId }).select('name').lean() : null;
        const fileName = zipFileNames(event.title, sess ? sess.name : null, zips)[part - 1];
        res.status(200);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${asciiName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        res.setHeader('X-Zip-Part', String(part));
        res.setHeader('X-Zip-Count', String(zips));
        res.setHeader('X-Guests-Total', String(total));
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Zip-Part, X-Zip-Count, X-Guests-Total');
        await writePartZip(actor, event, guests, firstIndex, res);
    }
};
