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
exports.rebuildUploadedLayout = rebuildUploadedLayout;
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
const WORDING = ['title', 'dateTime', 'venue'];
/**
 * The card of an uploaded design, built from where things are in the picture (`zones`):
 *  - the guest's QR code goes in the design's own QR box (or the quietest spot of the picture);
 *  - the guest's name and extra details only where the design left a place for them: with no place, they are not added;
 *  - when `replaceWording` (admin uploads), the event's name, date and time and venue are written over the design's own wording, which is
 *    painted out of the picture first. The picture is otherwise untouched, and nothing is drawn behind anything.
 */
function buildSpecFromZones(imageKey, width, height, zones, replaceWording, lightPicture) {
    const presetId = presetFor(width, height);
    const { width: W, height: H } = designSpec_1.CANVAS_PRESETS[presetId];
    const elements = [];
    const kept = zones.filter((z) => replaceWording || !WORDING.includes(z.role));
    kept.forEach((z, i) => {
        if (z.role === 'qr')
            return;
        const erase = z.erase ?? WORDING.includes(z.role);
        if (erase)
            elements.push({ type: 'patch', id: `patch${i}`, x: Math.round(z.x), y: Math.round(z.y), w: Math.max(4, Math.round(z.w)), h: Math.max(4, Math.round(z.h)) });
        const perLine = z.h / Math.max(1, z.lines);
        // the type is sized to the area it replaces, but never larger than reads well for that kind of detail
        const cap = Math.round(H * (z.role === 'title' ? 0.09 : z.role === 'dateTime' ? 0.034 : 0.03));
        const size = Math.max(12, Math.min(cap, Math.round(perLine * 0.74)));
        elements.push({
            type: 'text', id: `zone${i}`, role: z.role, x: Math.round(z.x), y: Math.round(z.y), w: Math.max(20, Math.round(z.w)), h: Math.max(10, Math.round(z.h)), align: z.align, valign: 'middle',
            fontFamily: z.fontFamily, fontWeight: z.fontWeight, size, minSize: Math.max(8, Math.round(size * 0.5)), lineHeight: 1.12, letterSpacing: 0, uppercase: false, maxLines: Math.max(1, Math.min(8, z.lines)), color: z.color, opacity: 1
        });
    });
    const q = zones.find((z) => z.role === 'qr');
    const side = Math.max(120, Math.min(1600, Math.round(q ? Math.min(q.w, q.h) : 0.27 * W)));
    const qx = Math.round(q ? q.x : (W - side) / 2), qy = Math.round(q ? q.y : H - Math.round(0.06 * H) - side);
    const ink = lightPicture ? '#111111' : '#FFFFFF';
    elements.push({ type: 'qr', purpose: 'INVITATION', id: 'qr', x: qx, y: qy, size: side, padding: q?.frame ? 0.04 : 0.07, radius: q?.frame ? 0 : 22, ...(q?.frame ? { frameColor: '#FFFFFF' } : {}) });
    return (0, designSpec_1.parseDesignSpec)({
        version: 1,
        kind: 'INVITATION',
        canvas: { preset: presetId, width: W, height: H },
        background: '#000000',
        backgroundMedia: imageKey,
        palette: { background: '#000000', primary: ink, accent: ink, text: ink },
        elements,
        meta: { generator: 'UPLOAD', ...(replaceWording && kept.some((z) => WORDING.includes(z.role)) ? { zones: true } : {}) }
    });
}
/** Admin uploads: the picture, its wording replaced by the event's details, the QR code (and the guest's name where there is a place for it) */
function buildDynamicUploadedSpec(imageKey, width, height, lightPicture = false, zones = []) {
    return buildSpecFromZones(imageKey, width, height, zones, true, lightPicture);
}
/** Organizer uploads: the finished design as it is, with the guest's QR code in the right place on it */
function buildUploadedSpec(imageKey, width, height, zones = [], lightPicture = false) {
    return buildSpecFromZones(imageKey, width, height, zones, false, lightPicture);
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
    const { width: W, height: H } = designSpec_1.CANVAS_PRESETS[presetFor(media.width, media.height)];
    // the layout of the picture is read for everyone: where the QR code goes, and (for admins) where the event's wording is
    const found = await detectInUpload(input.imageKey, W, H);
    const light = await isLightAtBottom(input.imageKey, W, H);
    const spec = dynamic ? buildDynamicUploadedSpec(input.imageKey, media.width, media.height, light, found.zones) : buildUploadedSpec(input.imageKey, media.width, media.height, found.zones, light);
    const detection = { detected: found.detected, reason: found.reason };
    const created = await Template_1.Template.create({
        name: input.name?.trim() || `Uploaded template ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
        ...(input.categoryId ? { categoryId: new mongoose_1.default.Types.ObjectId(input.categoryId) } : {}),
        ...(input.subcategoryId ? { subcategoryId: new mongoose_1.default.Types.ObjectId(input.subcategoryId) } : {}),
        previewImageKey: input.imageKey,
        cardDesign: 'CUSTOM',
        kind: 'INVITATION',
        designSpec: spec,
        // lets the Templates screen tell an uploaded design from an AI-made one
        templateData: { uploaded: true, layoutVersion: 2, ...(dynamic ? { dynamicDetails: true, textAreas: detection.detected ? 'AUTO' : 'NONE' } : {}) },
        ownerId: new mongoose_1.default.Types.ObjectId(actor.userId),
        // an organizer's upload is private to them; an admin's is shared: every organizer can use it (for its category / subcategory)
        isSystemTemplate: dynamic,
        // an admin's upload is a draft until its wording has been found or marked: a card with no event details on it is not offered to organizers
        isPublished: !dynamic || detection.detected,
        isActive: true
    });
    if (dynamic && detection.detected)
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
async function ownUpload(actor, id) {
    if (!mongoose_1.default.isValidObjectId(id))
        throw new UploadError(404, 'Template not found');
    const t = await Template_1.Template.findOne({ _id: id, ownerId: actor.userId, 'templateData.uploaded': true });
    if (!t)
        throw new UploadError(404, 'Template not found');
    return t;
}
/** The areas now in the design, as the editor shows them (the QR code, the guest's name and details, and an admin upload's wording) */
const zoneElements = (spec) => {
    const els = spec?.elements || [];
    const out = [];
    for (const e of els) {
        if (e.type === 'qr')
            out.push({ role: 'qr', x: e.x, y: e.y, w: e.size, h: e.size, lines: 1, color: '#000000', fontFamily: 'Inter', fontWeight: 400, align: 'center', frame: !!e.frameColor });
        if (e.type === 'text' && /^zone\d+$/.test(e.id || '')) {
            const n = String(e.id).slice(4);
            out.push({ role: e.role, x: e.x, y: e.y, w: e.w, h: e.h, lines: e.maxLines, color: e.color, fontFamily: e.fontFamily, fontWeight: e.fontWeight, align: e.align, erase: els.some((p) => p.type === 'patch' && p.id === `patch${n}`) });
        }
    }
    return out;
};
/** What the editor needs: the picture, the canvas it is drawn on, the areas now in use, and which kind of upload it is */
async function getTextZones(actor, id) {
    const t = await ownUpload(actor, id);
    return { imageKey: t.previewImageKey, canvas: t.designSpec?.canvas, zones: zoneElements(t.designSpec), mode: t.templateData?.textAreas || 'NONE', dynamic: t.templateData?.dynamicDetails === true };
}
async function saveZones(t, zones, mode) {
    const { width: W, height: H } = t.designSpec.canvas;
    const dynamic = t.templateData?.dynamicDetails === true;
    const light = await isLightAtBottom(t.previewImageKey, W, H);
    const next = dynamic ? buildDynamicUploadedSpec(t.previewImageKey, W, H, light, zones) : buildUploadedSpec(t.previewImageKey, W, H, zones, light);
    const firstAreas = dynamic && zones.some((z) => WORDING.includes(z.role)) && (t.templateData?.textAreas ?? 'NONE') === 'NONE';
    const updated = await Template_1.Template.findByIdAndUpdate(t._id, { designSpec: next, 'templateData.layoutVersion': 2, ...(dynamic ? { 'templateData.textAreas': mode } : {}), ...(firstAreas ? { isPublished: true } : {}) }, { new: true });
    return { updated, firstAreas };
}
/** The areas marked by hand replace whatever was found */
async function setTextZones(actor, id, zones) {
    const t = await ownUpload(actor, id);
    const { width: W, height: H } = t.designSpec.canvas;
    const inside = zones.map((z) => ({ ...z, x: Math.max(0, Math.min(W - 4, z.x)), y: Math.max(0, Math.min(H - 4, z.y)), w: Math.max(4, Math.min(W - z.x, z.w)), h: Math.max(4, Math.min(H - z.y, z.h)) }))
        // a code is square
        .map((z) => (z.role === 'qr' ? { ...z, w: Math.min(z.w, z.h), h: Math.min(z.w, z.h) } : z));
    const { updated, firstAreas } = await saveZones(t, inside, inside.some((z) => WORDING.includes(z.role)) ? 'MANUAL' : 'NONE');
    if (updated && firstAreas)
        await (0, template_service_1.announceTemplate)(updated);
    return updated;
}
/** Looks at the picture again (for example after it was replaced) */
async function redetectTextZones(actor, id) {
    const t = await ownUpload(actor, id);
    const { width: W, height: H } = t.designSpec.canvas;
    const found = await detectInUpload(t.previewImageKey, W, H);
    const { updated, firstAreas } = await saveZones(t, found.zones, found.detected ? 'AUTO' : 'NONE');
    if (updated && firstAreas)
        await (0, template_service_1.announceTemplate)(updated);
    return { template: updated, detected: found.detected, reason: found.reason };
}
/**
 * Lays an existing uploaded design out again with the current rules (used by scripts/migrate-uploaded-layout.js): the picture is read, the QR
 * code gets its place, and for an admin upload the wording is found. Whether the template is published is left as it is.
 */
async function rebuildUploadedLayout(templateId) {
    const t = (await Template_1.Template.findOne({ _id: templateId, 'templateData.uploaded': true }));
    if (!t || !t.designSpec?.canvas)
        throw new UploadError(404, 'Template not found');
    const { width: W, height: H } = t.designSpec.canvas;
    const dynamic = t.templateData?.dynamicDetails === true;
    const found = await detectInUpload(t.previewImageKey, W, H);
    const light = await isLightAtBottom(t.previewImageKey, W, H);
    const next = dynamic ? buildDynamicUploadedSpec(t.previewImageKey, W, H, light, found.zones) : buildUploadedSpec(t.previewImageKey, W, H, found.zones, light);
    await Template_1.Template.findByIdAndUpdate(t._id, { designSpec: next, 'templateData.layoutVersion': 2, ...(dynamic ? { 'templateData.textAreas': found.detected ? 'AUTO' : 'NONE' } : {}) });
    return { dynamic, detected: found.detected, zones: found.zones.map((z) => z.role), reason: found.reason };
}
