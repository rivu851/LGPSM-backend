import { User } from '../../models/User';
import { canUseCategory } from '../category.service';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { resolveImageKeyBase64 } from '../../utils/resolveImageBase64';
import { Template } from '../../models/Template';
import { announceTemplate } from '../template.service';
import { Media, MediaPurpose } from '../../models/Media';
import { mediaIdFromKey } from '../../utils/mediaKey';
import { CANVAS_PRESETS, CanvasPresetId, DesignSpec, parseDesignSpec } from './designSpec';
import { detectTextZones, TextZone, ZoneRole } from './textZones';

/**
 * "Upload your own template": the organizer's finished invitation design becomes the card. The event details are already in
 * their artwork, so only what is personal to each guest is added on top: the guest's own QR code (with its thin white margin, so it scans)
 * and name, straight onto the picture with no panel behind them.
 */
const PRESETS: CanvasPresetId[] = ['INVITATION_PORTRAIT', 'INVITATION_CARD', 'INVITATION_SQUARE'];

/** The canvas whose shape is closest to the picture, so little of it is cropped */
export function presetFor(width?: number, height?: number): CanvasPresetId {
  if (!width || !height) return 'INVITATION_CARD';
  const ratio = width / height;
  return PRESETS.reduce((best, id) => (Math.abs(CANVAS_PRESETS[id].width / CANVAS_PRESETS[id].height - ratio) < Math.abs(CANVAS_PRESETS[best].width / CANVAS_PRESETS[best].height - ratio) ? id : best), PRESETS[0]);
}

const WORDING: ZoneRole[] = ['title', 'dateTime', 'venue'];

/**
 * The card of an uploaded design, built from where things are in the picture (`zones`):
 *  - the guest's QR code goes in the design's own QR box (or the quietest spot of the picture);
 *  - the guest's name and extra details only where the design left a place for them: with no place, they are not added;
 *  - when `replaceWording` (admin uploads), the event's name, date and time and venue are written over the design's own wording, which is
 *    painted out of the picture first. The picture is otherwise untouched, and nothing is drawn behind anything.
 */
function buildSpecFromZones(imageKey: string, width: number | undefined, height: number | undefined, zones: TextZone[], replaceWording: boolean, lightPicture: boolean): DesignSpec {
  const presetId = presetFor(width, height);
  const { width: W, height: H } = CANVAS_PRESETS[presetId];
  const elements: any[] = [];
  const kept = zones.filter((z) => replaceWording || !WORDING.includes(z.role));
  kept.forEach((z, i) => {
    if (z.role === 'qr') return;
    const erase = z.erase ?? WORDING.includes(z.role);
    if (erase) elements.push({ type: 'patch', id: `patch${i}`, x: Math.round(z.x), y: Math.round(z.y), w: Math.max(4, Math.round(z.w)), h: Math.max(4, Math.round(z.h)) });
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
  // an organizer's own design is sent exactly as it is: no QR code (or anything else) is added to it
  if (replaceWording) elements.push({ type: 'qr', purpose: 'INVITATION', id: 'qr', x: qx, y: qy, size: side, padding: q?.frame ? 0.04 : 0.07, radius: q?.frame ? 0 : 22, ...(q?.frame ? { frameColor: '#FFFFFF' } : {}) });
  return parseDesignSpec({
    version: 1,
    kind: 'INVITATION',
    canvas: { preset: presetId, width: W, height: H },
    background: '#000000',
    backgroundMedia: imageKey,
    palette: { background: '#000000', primary: ink, accent: ink, text: ink },
    elements,
    meta: { generator: 'UPLOAD', ...(replaceWording ? {} : { plain: true }), ...(replaceWording && kept.some((z) => WORDING.includes(z.role)) ? { zones: true } : {}) }
  });
}

/** Admin uploads: the picture, its wording replaced by the event's details, the QR code (and the guest's name where there is a place for it) */
export function buildDynamicUploadedSpec(imageKey: string, width?: number, height?: number, lightPicture = false, zones: TextZone[] = []): DesignSpec {
  return buildSpecFromZones(imageKey, width, height, zones, true, lightPicture);
}

/** Organizer uploads: the finished design as it is, with the guest's QR code in the right place on it */
export function buildUploadedSpec(imageKey: string, width?: number, height?: number, zones: TextZone[] = [], lightPicture = false): DesignSpec {
  return buildSpecFromZones(imageKey, width, height, zones, false, lightPicture);
}

/** Is the picture bright where the details go (its bottom third)? Decides between dark and light text. */
async function isLightAtBottom(imageKey: string, width: number, height: number): Promise<boolean> {
  try {
    const data = await resolveImageKeyBase64(imageKey);
    const comma = data.indexOf(',');
    if (comma < 0) return false;
    const strip = await sharp(Buffer.from(data.slice(comma + 1), 'base64'), { failOn: 'none', limitInputPixels: 40_000_000 }).rotate().resize(width, height, { fit: 'cover', position: 'centre' })
      .extract({ left: 0, top: Math.round(height * 0.66), width, height: height - Math.round(height * 0.66) }).stats();
    const [r, g, b] = strip.channels;
    return 0.2126 * r.mean + 0.7152 * g.mean + 0.0722 * b.mean > 150;
  } catch {
    return false;
  }
}

/**
 * How many characters an event title may have on an admin's uploaded design: what its title area can hold at the smallest size the text
 * may shrink to. A short area gives a shorter limit, so the title always fits the design. (Nothing for a design with no title area.)
 */
export function titleCharLimit(spec: any): number | undefined {
  const t = (spec?.elements || []).find((e: any) => e.type === 'text' && e.role === 'title');
  if (!t) return undefined;
  const perLine = Math.floor(t.w / Math.max(6, (t.minSize || t.size || 24) * 0.55));
  return Math.max(12, Math.min(50, perLine * Math.max(1, t.maxLines || 1)));
}
const withTitleLimit = (spec: any) => ({ 'templateData.titleMaxChars': titleCharLimit(spec) ?? null });

export class UploadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function createUploadedTemplate(actor: { userId: string; role?: string }, input: { name?: string; imageKey: string; categoryId?: string; subcategoryId?: string }) {
  const mediaId = mediaIdFromKey(input.imageKey);
  if (!mediaId) throw new UploadError(400, 'Upload the design as an image first');
  // the image must be one this person uploaded as a template: nobody can build a template out of someone else's picture
  const media = await Media.findOne({ _id: mediaId, ownerId: actor.userId, purpose: MediaPurpose.TEMPLATE }).select('width height').lean();
  if (!media) throw new UploadError(400, 'That image was not found. Upload it again.');
  // someone else's custom category is treated as missing
  if (input.categoryId && !(await canUseCategory(input.categoryId, input.subcategoryId, actor.userId))) throw new UploadError(400, 'That category was not found.');
  const dynamic = actor.role === 'ADMIN';
  const { width: W, height: H } = CANVAS_PRESETS[presetFor(media.width, media.height)];
  // the layout of the picture is read for everyone: where the QR code goes, and (for admins) where the event's wording is
  const found = await detectInUpload(input.imageKey, W, H);
  const light = await isLightAtBottom(input.imageKey, W, H);
  const spec = dynamic ? buildDynamicUploadedSpec(input.imageKey, media.width, media.height, light, found.zones) : buildUploadedSpec(input.imageKey, media.width, media.height, found.zones, light);
  const detection = { detected: found.detected, reason: found.reason };
  const created = await Template.create({
    name: input.name?.trim() || `Uploaded template ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
    ...(input.categoryId ? { categoryId: new mongoose.Types.ObjectId(input.categoryId) } : {}),
    ...(input.subcategoryId ? { subcategoryId: new mongoose.Types.ObjectId(input.subcategoryId) } : {}),
    previewImageKey: input.imageKey,
    cardDesign: 'CUSTOM',
    kind: 'INVITATION',
    designSpec: spec,
    // lets the Templates screen tell an uploaded design from an AI-made one
    templateData: { uploaded: true, layoutVersion: 2, ...(dynamic ? { dynamicDetails: true, textAreas: detection.detected ? 'AUTO' : 'NONE', ...(titleCharLimit(spec) ? { titleMaxChars: titleCharLimit(spec) } : {}) } : {}) },
    ownerId: new mongoose.Types.ObjectId(actor.userId),
    // an organizer's upload is private to them; an admin's is shared: every organizer can use it (for its category / subcategory)
    isSystemTemplate: dynamic,
    isPublished: true,
    isActive: true
  });
  // an administrator's upload is shared with every organizer: they are told
  if (dynamic) await announceTemplate(created as any);
  return Object.assign(created.toObject(), { detection });
}

/** The picture as the card draws it (cropped to the canvas), for finding the wording */
async function canvasPicture(imageKey: string, width: number, height: number): Promise<Buffer | null> {
  try {
    const data = await resolveImageKeyBase64(imageKey);
    const comma = data.indexOf(',');
    if (comma < 0) return null;
    return await sharp(Buffer.from(data.slice(comma + 1), 'base64'), { failOn: 'none', limitInputPixels: 40_000_000 }).rotate().resize(width, height, { fit: 'cover', position: 'centre' }).png().toBuffer();
  } catch {
    return null;
  }
}

async function detectInUpload(imageKey: string, width: number, height: number) {
  const picture = await canvasPicture(imageKey, width, height);
  if (!picture) return { detected: false, zones: [] as TextZone[], reason: 'The picture could not be read.' };
  return detectTextZones(picture, { width, height });
}

type OwnUpload = { _id: any; previewImageKey?: string; designSpec?: any; templateData?: any; ownerId?: any };
async function ownUpload(actor: { userId: string }, id: string): Promise<OwnUpload> {
  if (!mongoose.isValidObjectId(id)) throw new UploadError(404, 'Template not found');
  const t = await Template.findOne({ _id: id, ownerId: actor.userId, 'templateData.uploaded': true });
  if (!t) throw new UploadError(404, 'Template not found');
  return t as unknown as OwnUpload;
}

/** The areas now in the design, as the editor shows them (the QR code, the guest's name and details, and an admin upload's wording) */
const zoneElements = (spec: any): TextZone[] => {
  const els: any[] = spec?.elements || [];
  const out: TextZone[] = [];
  for (const e of els) {
    if (e.type === 'qr') out.push({ role: 'qr', x: e.x, y: e.y, w: e.size, h: e.size, lines: 1, color: '#000000', fontFamily: 'Inter', fontWeight: 400, align: 'center', frame: !!e.frameColor });
    if (e.type === 'text' && /^zone\d+$/.test(e.id || '')) {
      const n = String(e.id).slice(4);
      out.push({ role: e.role, x: e.x, y: e.y, w: e.w, h: e.h, lines: e.maxLines, color: e.color, fontFamily: e.fontFamily, fontWeight: e.fontWeight, align: e.align, erase: els.some((p) => p.type === 'patch' && p.id === `patch${n}`) });
    }
  }
  return out;
};

/** What the editor needs: the picture, the canvas it is drawn on, the areas now in use, and which kind of upload it is */
export async function getTextZones(actor: { userId: string }, id: string) {
  const t = await ownUpload(actor, id);
  return { imageKey: t.previewImageKey, canvas: t.designSpec?.canvas, zones: zoneElements(t.designSpec), mode: t.templateData?.textAreas || 'NONE', dynamic: t.templateData?.dynamicDetails === true };
}

async function saveZones(t: OwnUpload, zones: TextZone[], mode: 'AUTO' | 'MANUAL' | 'NONE') {
  const { width: W, height: H } = t.designSpec.canvas;
  const dynamic = t.templateData?.dynamicDetails === true;
  const light = await isLightAtBottom(t.previewImageKey as string, W, H);
  const next = dynamic ? buildDynamicUploadedSpec(t.previewImageKey as string, W, H, light, zones) : buildUploadedSpec(t.previewImageKey as string, W, H, zones, light);
  const updated = await Template.findByIdAndUpdate(t._id, { designSpec: next, 'templateData.layoutVersion': 2, ...(dynamic ? { 'templateData.textAreas': mode, ...withTitleLimit(next) } : {}) }, { new: true });
  return { updated };
}

/** The areas marked by hand replace whatever was found */
export async function setTextZones(actor: { userId: string }, id: string, zones: TextZone[]) {
  const t = await ownUpload(actor, id);
  const { width: W, height: H } = t.designSpec.canvas;
  const inside = zones.map((z) => ({ ...z, x: Math.max(0, Math.min(W - 4, z.x)), y: Math.max(0, Math.min(H - 4, z.y)), w: Math.max(4, Math.min(W - z.x, z.w)), h: Math.max(4, Math.min(H - z.y, z.h)) }))
    // a code is square
    .map((z) => (z.role === 'qr' ? { ...z, w: Math.min(z.w, z.h), h: Math.min(z.w, z.h) } : z));
  const { updated } = await saveZones(t, inside, inside.some((z) => WORDING.includes(z.role)) ? 'MANUAL' : 'NONE');
  return updated;
}

/** Looks at the picture again (for example after it was replaced) */
export async function redetectTextZones(actor: { userId: string }, id: string) {
  const t = await ownUpload(actor, id);
  const { width: W, height: H } = t.designSpec.canvas;
  const found = await detectInUpload(t.previewImageKey as string, W, H);
  const { updated } = await saveZones(t, found.zones, found.detected ? 'AUTO' : 'NONE');
  return { template: updated, detected: found.detected, reason: found.reason };
}

/**
 * Lays an existing uploaded design out again with the current rules (used by scripts/migrate-uploaded-layout.js): the picture is read, the QR
 * code gets its place, and for an admin upload the wording is found. Whether the template is published is left as it is.
 */
export async function rebuildUploadedLayout(templateId: string) {
  const t = (await Template.findOne({ _id: templateId, 'templateData.uploaded': true })) as unknown as OwnUpload | null;
  if (!t || !t.designSpec?.canvas) throw new UploadError(404, 'Template not found');
  const { width: W, height: H } = t.designSpec.canvas;
  const dynamic = t.templateData?.dynamicDetails === true;
  const found = await detectInUpload(t.previewImageKey as string, W, H);
  const light = await isLightAtBottom(t.previewImageKey as string, W, H);
  const next = dynamic ? buildDynamicUploadedSpec(t.previewImageKey as string, W, H, light, found.zones) : buildUploadedSpec(t.previewImageKey as string, W, H, found.zones, light);
  // An upload by an administrator is shared with every organizer (a few older ones were saved as private): repaired here, so it can be chosen and used
  const owner = (t as any).ownerId ? await User.findById((t as any).ownerId).select('role').lean() : null;
  const shareIt = owner?.role === 'ADMIN' && (t as any).isSystemTemplate !== true;
  await Template.findByIdAndUpdate(t._id, { designSpec: next, 'templateData.layoutVersion': 2, ...(dynamic ? { 'templateData.textAreas': found.detected ? 'AUTO' : 'NONE', ...withTitleLimit(next) } : {}), ...(shareIt ? { isSystemTemplate: true } : {}) });
  return { dynamic, detected: found.detected, zones: found.zones.map((z) => z.role), reason: found.reason, shared: shareIt };
}

/**
 * An admin's upload saved before the design's own wording was read (or read with an older version of the reading) is read now, once, so the
 * event's details replace that wording. Called wherever a card is drawn from a template (previews and real sends). Returns the template
 * with its current layout; never throws (a design that cannot be read is drawn as it is).
 */
/**
 * An organizer's own uploaded design is the picture exactly as it is: nothing is drawn on it. A design saved by an older version can still
 * carry a QR code, wording zones or patches in its stored specification, so they are dropped whenever the design is read.
 */
export function asStaticUpload<T extends { designSpec?: unknown; templateData?: any; isSystemTemplate?: boolean }>(template: T | null): T | null {
  const d = template?.templateData;
  // an administrator's upload is a shared (system) design whose details are replaced by the event's: it is left as it is
  if (!template || !d?.uploaded || d.dynamicDetails || template.isSystemTemplate) return template;
  const spec: any = template.designSpec;
  if (!spec || typeof spec !== 'object') return template;
  if ((spec.elements ?? []).length === 0 && spec.meta?.plain) return template;
  return { ...template, designSpec: { ...spec, elements: [], meta: { ...(spec.meta ?? {}), plain: true } } };
}

export async function withCurrentLayout<T extends { _id?: unknown; designSpec?: unknown; templateData?: any }>(input: T | null): Promise<T | null> {
  const template = asStaticUpload(input);
  const d = template?.templateData;
  if (!template || !d?.uploaded || !d.dynamicDetails || d.textAreas === 'MANUAL') return template;
  if (d.textAreas !== undefined && d.layoutVersion === 2) return template;
  try {
    await rebuildUploadedLayout(String(template._id));
    const fresh = await Template.findById(template._id as never).select('designSpec templateData isSystemTemplate').lean();
    if (fresh) return { ...template, designSpec: fresh.designSpec, templateData: fresh.templateData, isSystemTemplate: fresh.isSystemTemplate };
  } catch (err) {
    console.error('Uploaded design layout could not be read:', (err as Error).message);
  }
  return template;
}
