import { canUseCategory } from '../category.service';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { resolveImageKeyBase64 } from '../../utils/resolveImageBase64';
import { Template } from '../../models/Template';
import { announceTemplate } from '../template.service';
import { Media, MediaPurpose } from '../../models/Media';
import { mediaIdFromKey } from '../../utils/mediaKey';
import { CANVAS_PRESETS, CanvasPresetId, DesignSpec, parseDesignSpec } from './designSpec';
import { detectTextZones, TextZone } from './textZones';

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

/**
 * Dynamic variant (admin uploads): the picture stays as it is. The wording the designer printed in it (the event name, the date and time,
 * the venue) is found, painted out of the picture from the background around it, and the event's own details are written in the same
 * place, in the same colour, so the card reads as the designer made it. The guest's QR code and name are added on top (the QR code
 * with no white tile behind it). With no wording found (`zones` empty) the card is the picture, the QR code and the name only, until the
 * areas are marked by hand.
 */
export function buildDynamicUploadedSpec(imageKey: string, width?: number, height?: number, lightPicture = false, zones: TextZone[] = []): DesignSpec {
  const presetId = presetFor(width, height);
  const { width: W, height: H } = CANVAS_PRESETS[presetId];
  const m = Math.round(0.05 * W);
  const qr = Math.round(0.27 * W);
  const bottom = H - Math.round(0.045 * H) - qr;
  const tx = m + qr + Math.round(0.04 * W);
  const tw = W - m - tx;
  const ink = lightPicture ? { strong: '#111111', soft: '#333333' } : { strong: '#FFFFFF', soft: '#EDEDED' };
  const guestRows = [['inviteeName', 0.3, 0.048, 700, ink.strong, 1], ['inviteeMeta', 0.16, 0.032, 400, ink.soft, 1]] as const;
  let y = bottom + Math.round(qr * 0.3);
  const guestTexts = guestRows.map(([role, frac, size, weight, color, maxLines]) => {
    const h = Math.round(qr * frac);
    const el = {
      type: 'text' as const, role, x: tx, y, w: tw, h, align: 'left' as const, valign: 'middle' as const,
      fontFamily: 'Inter' as const, fontWeight: weight as 400 | 600 | 700, size: Math.round(size * W), minSize: Math.round(size * W * 0.55),
      lineHeight: 1.12, letterSpacing: 0, uppercase: false, maxLines, color, opacity: 1
    };
    y += h;
    return el;
  });
  const areas = zones.flatMap((z, i) => {
    const perLine = z.h / Math.max(1, z.lines);
    const size = Math.max(12, Math.round(perLine * 0.74));
    return [
      { type: 'patch' as const, id: `patch${i}`, x: Math.round(z.x), y: Math.round(z.y), w: Math.max(4, Math.round(z.w)), h: Math.max(4, Math.round(z.h)) },
      {
        type: 'text' as const, id: `zone${i}`, role: z.role, x: Math.round(z.x), y: Math.round(z.y), w: Math.max(20, Math.round(z.w)), h: Math.max(10, Math.round(z.h)), align: z.align, valign: 'middle' as const,
        fontFamily: z.fontFamily, fontWeight: z.fontWeight, size, minSize: Math.max(8, Math.round(size * 0.5)), lineHeight: 1.12, letterSpacing: 0, uppercase: false, maxLines: Math.max(1, Math.min(8, z.lines)), color: z.color, opacity: 1
      }
    ];
  });
  return parseDesignSpec({
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

export function buildUploadedSpec(imageKey: string, width?: number, height?: number): DesignSpec {
  const presetId = presetFor(width, height);
  const { width: W, height: H } = CANVAS_PRESETS[presetId];
  const pad = Math.round(0.035 * W);
  const qr = Math.round(0.4 * W);
  const nameH = Math.round(0.07 * W);
  const metaH = Math.round(0.05 * W);
  const panelW = Math.round(0.7 * W);
  const panelH = pad + qr + pad + nameH + metaH + pad;
  const panelX = Math.round((W - panelW) / 2);
  const panelY = H - panelH - Math.round(0.05 * H);
  const text = (role: 'inviteeName' | 'inviteeMeta', y: number, h: number, size: number, weight: 400 | 700, color: string) => ({
    type: 'text' as const, role, x: panelX + pad, y, w: panelW - 2 * pad, h, align: 'center' as const, valign: 'middle' as const,
    fontFamily: 'Inter' as const, fontWeight: weight, size, minSize: Math.round(size * 0.6), lineHeight: 1.15, letterSpacing: 0, uppercase: false, maxLines: 1, color, opacity: 1
  });
  const qrY = panelY + pad;
  return parseDesignSpec({
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
  let detection: { detected: boolean; reason?: string } | null = null;
  const spec = dynamic
    ? await (async () => {
        const { width: W, height: H } = CANVAS_PRESETS[presetFor(media.width, media.height)];
        const found = await detectInUpload(input.imageKey, W, H);
        detection = { detected: found.detected, reason: found.reason };
        return buildDynamicUploadedSpec(input.imageKey, media.width, media.height, await isLightAtBottom(input.imageKey, W, H), found.detected ? found.zones : []);
      })()
    : buildUploadedSpec(input.imageKey, media.width, media.height);
  const created = await Template.create({
    name: input.name?.trim() || `Uploaded template ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
    ...(input.categoryId ? { categoryId: new mongoose.Types.ObjectId(input.categoryId) } : {}),
    ...(input.subcategoryId ? { subcategoryId: new mongoose.Types.ObjectId(input.subcategoryId) } : {}),
    previewImageKey: input.imageKey,
    cardDesign: 'CUSTOM',
    kind: 'INVITATION',
    designSpec: spec,
    // lets the Templates screen tell an uploaded design from an AI-made one
    templateData: { uploaded: true, ...(dynamic ? { dynamicDetails: true, textAreas: (detection as { detected: boolean } | null)?.detected ? 'AUTO' : 'NONE' } : {}) },
    ownerId: new mongoose.Types.ObjectId(actor.userId),
    // an organizer's upload is private to them; an admin's is shared: every organizer can use it (for its category / subcategory)
    isSystemTemplate: dynamic,
    // an admin's upload is a draft until its wording has been found or marked: a card with no event details on it is not offered to organizers
    isPublished: !dynamic || !!(detection as { detected: boolean } | null)?.detected,
    isActive: true
  });
  // Shared with every organizer only once the wording has been found (or marked): until then the admin is asked to mark the text areas
  if (dynamic && detection && (detection as { detected: boolean }).detected) await announceTemplate(created as any);
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

type DynamicUpload = { _id: any; previewImageKey?: string; designSpec?: any; templateData?: any; ownerId?: any };
async function ownDynamicUpload(actor: { userId: string }, id: string): Promise<DynamicUpload> {
  if (!mongoose.isValidObjectId(id)) throw new UploadError(404, 'Template not found');
  const t = await Template.findOne({ _id: id, ownerId: actor.userId, 'templateData.uploaded': true, 'templateData.dynamicDetails': true });
  if (!t) throw new UploadError(404, 'Template not found');
  return t as unknown as DynamicUpload;
}

const zoneElements = (spec: any): TextZone[] => (spec?.elements || []).filter((e: any) => e.type === 'text' && /^zone\d+$/.test(e.id || '')).map((e: any) => ({
  role: e.role, x: e.x, y: e.y, w: e.w, h: e.h, lines: e.maxLines, color: e.color, fontFamily: e.fontFamily, fontWeight: e.fontWeight, align: e.align
}));

/** What the editor needs: the picture, the canvas it is drawn on, and the areas now in use */
export async function getTextZones(actor: { userId: string }, id: string) {
  const t = await ownDynamicUpload(actor, id);
  return { imageKey: t.previewImageKey, canvas: t.designSpec?.canvas, zones: zoneElements(t.designSpec), mode: t.templateData?.textAreas || 'NONE' };
}

async function saveZones(t: DynamicUpload, zones: TextZone[], mode: 'AUTO' | 'MANUAL' | 'NONE') {
  const spec = t.designSpec;
  const { width: W, height: H } = spec.canvas;
  const light = await isLightAtBottom(t.previewImageKey as string, W, H);
  const next = buildDynamicUploadedSpec(t.previewImageKey as string, W, H, light, zones);
  const firstAreas = zones.length > 0 && (t.templateData?.textAreas ?? 'NONE') === 'NONE';
  const updated = await Template.findByIdAndUpdate(t._id, { designSpec: next, 'templateData.textAreas': mode, ...(firstAreas ? { isPublished: true } : {}) }, { new: true });
  return updated;
}

/** The areas marked by hand replace whatever was found */
export async function setTextZones(actor: { userId: string }, id: string, zones: TextZone[]) {
  const t = await ownDynamicUpload(actor, id);
  const { width: W, height: H } = t.designSpec.canvas;
  const inside = zones.map((z) => ({ ...z, x: Math.max(0, Math.min(W - 4, z.x)), y: Math.max(0, Math.min(H - 4, z.y)), w: Math.max(4, Math.min(W - z.x, z.w)), h: Math.max(4, Math.min(H - z.y, z.h)) }));
  const updated = await saveZones(t, inside, inside.length ? 'MANUAL' : 'NONE');
  if (updated && inside.length && t.templateData?.textAreas === 'NONE') await announceTemplate(updated as any);
  return updated;
}

/** Looks for the wording again (for example after the picture was replaced) */
export async function redetectTextZones(actor: { userId: string }, id: string) {
  const t = await ownDynamicUpload(actor, id);
  const { width: W, height: H } = t.designSpec.canvas;
  const found = await detectInUpload(t.previewImageKey as string, W, H);
  const updated = await saveZones(t, found.detected ? found.zones : [], found.detected ? 'AUTO' : 'NONE');
  if (updated && found.detected && t.templateData?.textAreas === 'NONE') await announceTemplate(updated as any);
  return { template: updated, detected: found.detected, reason: found.reason };
}
