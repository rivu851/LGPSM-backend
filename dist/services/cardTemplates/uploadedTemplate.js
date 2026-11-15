"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UploadError = void 0;
exports.presetFor = presetFor;
exports.buildDynamicUploadedSpec = buildDynamicUploadedSpec;
exports.buildUploadedSpec = buildUploadedSpec;
exports.createUploadedTemplate = createUploadedTemplate;
exports.getTextZones = getTextZones;
exports.setTextZones = setTextZones;
exports.redetectTextZones = redetectTextZones;
const category_service_1 = require("../category.service");
const mongoose_1 = __importDefault(require("mongoose"));
const sharp_1 = __importDefault(require("sharp"));
const resolveImageBase64_1 = require("../../utils/resolveImageBase64");
const Template_1 = require("../../models/Template");
const template_service_1 = require("../template.service");
const Media_1 = require("../../models/Media");
const mediaKey_1 = require("../../utils/mediaKey");
const designSpec_1 = require("./designSpec");
const textZones_1 = require("./textZones");
/**
 * "Upload your own template": the organizer's finished invitation design becomes the card. The event details are already in
 * their artwork, so only what is personal to each guest is added on top: the guest's own QR code (with its thin white margin, so it scans)
 * and name, straight onto the picture with no panel behind them.
 */
const PRESETS = ['INVITATION_PORTRAIT', 'INVITATION_CARD', 'INVITATION_SQUARE'];
/** The canvas whose shape is closest to the picture, so little of it is cropped */
function presetFor(width, height) {
    if (!width || !height)
        return 'INVITATION_CARD';
    const ratio = width / height;
    return PRESETS.reduce((best, id) => (Math.abs(designSpec_1.CANVAS_PRESETS[id].width / designSpec_1.CANVAS_PRESETS[id].height - ratio) < Math.abs(designSpec_1.CANVAS_PRESETS[best].width / designSpec_1.CANVAS_PRESETS[best].height - ratio) ? id : best), PRESETS[0]);
}
/**
 * Dynamic variant (admin uploads): the picture stays as it is. The wording the designer printed in it (the event name, the date and time,
 * the venue) is found, painted out of the picture from the background around it, and the event's own details are written in the same
 * place, in the same colour, so the card reads as the designer made it. The guest's QR code and name are added on top (the QR code
 * with no white tile behind it). With no wording found (`zones` empty) the card is the picture, the QR code and the name only, until the
 * areas are marked by hand.
 */
function buildDynamicUploadedSpec(imageKey, width, height, lightPicture = false, zones = []) {
    const presetId = presetFor(width, height);
    const { width: W, height: H } = designSpec_1.CANVAS_PRESETS[presetId];
    const m = Math.round(0.05 * W);
    const qr = Math.round(0.27 * W);
    const bottom = H - Math.round(0.045 * H) - qr;
    const tx = m + qr + Math.round(0.04 * W);
    const tw = W - m - tx;
    const ink = lightPicture ? { strong: '#111111', soft: '#333333' } : { strong: '#FFFFFF', soft: '#EDEDED' };
    const guestRows = [['inviteeName', 0.3, 0.048, 700, ink.strong, 1], ['inviteeMeta', 0.16, 0.032, 400, ink.soft, 1]];
    let y = bottom + Math.round(qr * 0.3);
    const guestTexts = guestRows.map(([role, frac, size, weight, color, maxLines]) => {
        const h = Math.round(qr * frac);
        const el = {
            type: 'text', role, x: tx, y, w: tw, h, align: 'left', valign: 'middle',
            fontFamily: 'Inter', fontWeight: weight, size: Math.round(size * W), minSize: Math.round(size * W * 0.55),
            lineHeight: 1.12, letterSpacing: 0, uppercase: false, maxLines, color, opacity: 1
        };
        y += h;
        return el;
    });
    const areas = zones.flatMap((z, i) => {
        const perLine = z.h / Math.max(1, z.lines);
        const size = Math.max(12, Math.round(perLine * 0.74));
        return [
            { type: 'patch', id: `patch${i}`, x: Math.round(z.x), y: Math.round(z.y), w: Math.max(4, Math.round(z.w)), h: Math.max(4, Math.round(z.h)) },
            {
                type: 'text', id: `zone${i}`, role: z.role, x: Math.round(z.x), y: Math.round(z.y), w: Math.max(20, Math.round(z.w)), h: Math.max(10, Math.round(z.h)), align: z.align, valign: 'middle',
                fontFamily: z.fontFamily, fontWeight: z.fontWeight, size, minSize: Math.max(8, Math.round(size * 0.5)), lineHeight: 1.12, letterSpacing: 0, uppercase: false, maxLines: Math.max(1, Math.min(8, z.lines)), color: z.color, opacity: 1
            }
        ];
    });
    return (0, designSpec_1.parseDesignSpec)({
        version: 1,
        kind: 'INVITATION',
        canvas: { preset: presetId, width: W, height: H },
        background: '#000000',
        backgroundMedia: imageKey,
        palette: { background: '#000000', primary: ink.strong, accent: ink.strong, text: ink.strong },
        elements: [
            ...areas,
            { type: 'qr', purpose: 'INVITATION', x: m, y: bottom, size: qr, padding: 0.07, radius: 22 },
            ...guestTexts
        ],
        meta: { generator: 'UPLOAD', ...(zones.length ? { zones: true } : {}) }
    });
}
function buildUploadedSpec(imageKey, width, height) {
    const presetId = presetFor(width, height);
    const { width: W, height: H } = designSpec_1.CANVAS_PRESETS[presetId];
    const pad = Math.round(0.035 * W);
    const qr = Math.round(0.4 * W);
    const nameH = Math.round(0.07 * W);
    const metaH = Math.round(0.05 * W);
    const panelW = Math.round(0.7 * W);
    const panelH = pad + qr + pad + nameH + metaH + pad;
    const panelX = Math.round((W - panelW) / 2);
    const panelY = H - panelH - Math.round(0.05 * H);
    const text = (role, y, h, size, weight, color) => ({
        type: 'text', role, x: panelX + pad, y, w: panelW - 2 * pad, h, align: 'center', valign: 'middle',
        fontFamily: 'Inter', fontWeight: weight, size, minSize: Math.round(size * 0.6), lineHeight: 1.15, letterSpacing: 0, uppercase: false, maxLines: 1, color, opacity: 1
    });
    const qrY = panelY + pad;
    return (0, designSpec_1.parseDesignSpec)({
        version: 1,
        kind: 'INVITATION',
        canvas: { preset: presetId, width: W, height: H },
        background: '#FFFFFF',
        backgroundMedia: imageKey,
        palette: { background: '#FFFFFF', primary: '#111111', accent: '#FF651D', text: '#111111' },
        elements: [
            { type: 'qr', purpose: 'INVITATION', x: Math.round((W - qr) / 2), y: qrY, size: qr, padding: 0.06, radius: 0 },
            text('inviteeName', qrY + qr + pad, nameH, Math.round(0.052 * W), 700, '#111111'),
            text('inviteeMeta', qrY + qr + pad + nameH, metaH, Math.round(0.036 * W), 400, '#444444')
        ],
        meta: { generator: 'UPLOAD' }
    });
}
/** Is the picture bright where the details go (its bottom third)? Decides between dark and light text. */
async function isLightAtBottom(imageKey, width, height) {
    try {
        const data = await (0, resolveImageBase64_1.resolveImageKeyBase64)(imageKey);
        const comma = data.indexOf(',');
        if (comma < 0)
            return false;
        const strip = await (0, sharp_1.default)(Buffer.from(data.slice(comma + 1), 'base64'), { failOn: 'none', limitInputPixels: 40_000_000 }).rotate().resize(width, height, { fit: 'cover', position: 'centre' })
            .extract({ left: 0, top: Math.round(height * 0.66), width, height: height - Math.round(height * 0.66) }).stats();
        const [r, g, b] = strip.channels;
        return 0.2126 * r.mean + 0.7152 * g.mean + 0.0722 * b.mean > 150;
    }
    catch {
        return false;
    }
}
class UploadError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
exports.UploadError = UploadError;
async function createUploadedTemplate(actor, input) {
    const mediaId = (0, mediaKey_1.mediaIdFromKey)(input.imageKey);
    if (!mediaId)
        throw new UploadError(400, 'Upload the design as an image first');
    // the image must be one this person uploaded as a template: nobody can build a template out of someone else's picture
    const media = await Media_1.Media.findOne({ _id: mediaId, ownerId: actor.userId, purpose: Media_1.MediaPurpose.TEMPLATE }).select('width height').lean();
    if (!media)
        throw new UploadError(400, 'That image was not found. Upload it again.');
    // someone else's custom category is treated as missing
    if (input.categoryId && !(await (0, category_service_1.canUseCategory)(input.categoryId, input.subcategoryId, actor.userId)))
        throw new UploadError(400, 'That category was not found.');
    const dynamic = actor.role === 'ADMIN';
    let detection = null;
    const spec = dynamic
        ? await (async () => {
            const { width: W, height: H } = designSpec_1.CANVAS_PRESETS[presetFor(media.width, media.height)];
            const found = await detectInUpload(input.imageKey, W, H);
            detection = { detected: found.detected, reason: found.reason };
            return buildDynamicUploadedSpec(input.imageKey, media.width, media.height, await isLightAtBottom(input.imageKey, W, H), found.detected ? found.zones : []);
        })()
        : buildUploadedSpec(input.imageKey, media.width, media.height);
    const created = await Template_1.Template.create({
        name: input.name?.trim() || `Uploaded template ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
        ...(input.categoryId ? { categoryId: new mongoose_1.default.Types.ObjectId(input.categoryId) } : {}),
        ...(input.subcategoryId ? { subcategoryId: new mongoose_1.default.Types.ObjectId(input.subcategoryId) } : {}),
        previewImageKey: input.imageKey,
        cardDesign: 'CUSTOM',
        kind: 'INVITATION',
        designSpec: spec,
        // lets the Templates screen tell an uploaded design from an AI-made one
        templateData: { uploaded: true, ...(dynamic ? { dynamicDetails: true, textAreas: detection?.detected ? 'AUTO' : 'NONE' } : {}) },
        ownerId: new mongoose_1.default.Types.ObjectId(actor.userId),
        // an organizer's upload is private to them; an admin's is shared: every organizer can use it (for its category / subcategory)
        isSystemTemplate: dynamic,
        // an admin's upload is a draft until its wording has been found or marked: a card with no event details on it is not offered to organizers
        isPublished: !dynamic || !!detection?.detected,
        isActive: true
    });
    // Shared with every organizer only once the wording has been found (or marked): until then the admin is asked to mark the text areas
    if (dynamic && detection && detection.detected)
        await (0, template_service_1.announceTemplate)(created);
    return Object.assign(created.toObject(), { detection });
}
/** The picture as the card draws it (cropped to the canvas), for finding the wording */
async function canvasPicture(imageKey, width, height) {
    try {
        const data = await (0, resolveImageBase64_1.resolveImageKeyBase64)(imageKey);
        const comma = data.indexOf(',');
        if (comma < 0)
            return null;
        return await (0, sharp_1.default)(Buffer.from(data.slice(comma + 1), 'base64'), { failOn: 'none', limitInputPixels: 40_000_000 }).rotate().resize(width, height, { fit: 'cover', position: 'centre' }).png().toBuffer();
    }
    catch {
        return null;
    }
}
async function detectInUpload(imageKey, width, height) {
    const picture = await canvasPicture(imageKey, width, height);
    if (!picture)
        return { detected: false, zones: [], reason: 'The picture could not be read.' };
    return (0, textZones_1.detectTextZones)(picture, { width, height });
}
async function ownDynamicUpload(actor, id) {
    if (!mongoose_1.default.isValidObjectId(id))
        throw new UploadError(404, 'Template not found');
    const t = await Template_1.Template.findOne({ _id: id, ownerId: actor.userId, 'templateData.uploaded': true, 'templateData.dynamicDetails': true });
    if (!t)
        throw new UploadError(404, 'Template not found');
    return t;
}
const zoneElements = (spec) => (spec?.elements || []).filter((e) => e.type === 'text' && /^zone\d+$/.test(e.id || '')).map((e) => ({
    role: e.role, x: e.x, y: e.y, w: e.w, h: e.h, lines: e.maxLines, color: e.color, fontFamily: e.fontFamily, fontWeight: e.fontWeight, align: e.align
}));
/** What the editor needs: the picture, the canvas it is drawn on, and the areas now in use */
async function getTextZones(actor, id) {
    const t = await ownDynamicUpload(actor, id);
    return { imageKey: t.previewImageKey, canvas: t.designSpec?.canvas, zones: zoneElements(t.designSpec), mode: t.templateData?.textAreas || 'NONE' };
}
async function saveZones(t, zones, mode) {
    const spec = t.designSpec;
    const { width: W, height: H } = spec.canvas;
    const light = await isLightAtBottom(t.previewImageKey, W, H);
    const next = buildDynamicUploadedSpec(t.previewImageKey, W, H, light, zones);
    const firstAreas = zones.length > 0 && (t.templateData?.textAreas ?? 'NONE') === 'NONE';
    const updated = await Template_1.Template.findByIdAndUpdate(t._id, { designSpec: next, 'templateData.textAreas': mode, ...(firstAreas ? { isPublished: true } : {}) }, { new: true });
    return updated;
}
/** The areas marked by hand replace whatever was found */
async function setTextZones(actor, id, zones) {
    const t = await ownDynamicUpload(actor, id);
    const { width: W, height: H } = t.designSpec.canvas;
    const inside = zones.map((z) => ({ ...z, x: Math.max(0, Math.min(W - 4, z.x)), y: Math.max(0, Math.min(H - 4, z.y)), w: Math.max(4, Math.min(W - z.x, z.w)), h: Math.max(4, Math.min(H - z.y, z.h)) }));
    const updated = await saveZones(t, inside, inside.length ? 'MANUAL' : 'NONE');
    if (updated && inside.length && t.templateData?.textAreas === 'NONE')
        await (0, template_service_1.announceTemplate)(updated);
    return updated;
}
/** Looks for the wording again (for example after the picture was replaced) */
async function redetectTextZones(actor, id) {
    const t = await ownDynamicUpload(actor, id);
    const { width: W, height: H } = t.designSpec.canvas;
    const found = await detectInUpload(t.previewImageKey, W, H);
    const updated = await saveZones(t, found.detected ? found.zones : [], found.detected ? 'AUTO' : 'NONE');
    if (updated && found.detected && t.templateData?.textAreas === 'NONE')
        await (0, template_service_1.announceTemplate)(updated);
    return { template: updated, detected: found.detected, reason: found.reason };
}
