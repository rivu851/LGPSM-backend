import { canUseCategory } from '../category.service';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { resolveImageKeyBase64 } from '../../utils/resolveImageBase64';
import { Template } from '../../models/Template';
import { Media, MediaPurpose } from '../../models/Media';
import { mediaIdFromKey } from '../../utils/mediaKey';
import { CANVAS_PRESETS, CanvasPresetId, DesignSpec, parseDesignSpec } from './designSpec';

/**
 * "Upload your own template": the organizer's finished invitation design becomes the card. The event details are already in
 * their artwork, so only what is personal to each guest is added on top: the guest's own QR code and name, on a white panel at
 * the bottom so the code scans cleanly whatever the picture looks like.
 */
const PRESETS: CanvasPresetId[] = ['INVITATION_PORTRAIT', 'INVITATION_CARD', 'INVITATION_SQUARE'];

/** The canvas whose shape is closest to the picture, so little of it is cropped */
export function presetFor(width?: number, height?: number): CanvasPresetId {
  if (!width || !height) return 'INVITATION_CARD';
  const ratio = width / height;
  return PRESETS.reduce((best, id) => (Math.abs(CANVAS_PRESETS[id].width / CANVAS_PRESETS[id].height - ratio) < Math.abs(CANVAS_PRESETS[best].width / CANVAS_PRESETS[best].height - ratio) ? id : best), PRESETS[0]);
}

/**
 * Dynamic variant (admin uploads): the picture is only a background and stays untouched: no panel, no shade. The event's own
 * title, date & time, venue and the guest's name are drawn straight onto it from the event at render time (and follow the
 * card-display checkboxes, nothing is left behind when they are off). The text is light or dark depending on how bright the
 * picture is where it sits. Only the guest's QR code sits on a small white tile, because it has to scan.
 */
export function buildDynamicUploadedSpec(imageKey: string, width?: number, height?: number, lightPicture = false): DesignSpec {
  const presetId = presetFor(width, height);
  const { width: W, height: H } = CANVAS_PRESETS[presetId];
  const m = Math.round(0.05 * W);
  const qr = Math.round(0.27 * W);
  const bottom = H - Math.round(0.045 * H) - qr;
  const tx = m + qr + Math.round(0.04 * W);
  const tw = W - m - tx;
  const ink = lightPicture ? { strong: '#111111', accent: '#A83800', soft: '#333333' } : { strong: '#FFFFFF', accent: '#FFD2B8', soft: '#EDEDED' };
  const rows = [
    ['title', 0.3, 0.07, 700, ink.strong, 2], ['dateTime', 0.14, 0.036, 600, ink.accent, 1], ['venue', 0.14, 0.034, 400, ink.soft, 2],
    ['inviteeName', 0.22, 0.048, 700, ink.strong, 1], ['inviteeMeta', 0.12, 0.032, 400, ink.soft, 1]
  ] as const;
  let y = bottom;
  const texts = rows.map(([role, frac, size, weight, color, maxLines]) => {
    const h = Math.round(qr * frac);
    const el = {
      type: 'text' as const, role, x: tx, y, w: tw, h, align: 'left' as const, valign: 'middle' as const,
      fontFamily: 'Inter' as const, fontWeight: weight as 400 | 600 | 700, size: Math.round(size * W), minSize: Math.round(size * W * 0.55),
      lineHeight: 1.12, letterSpacing: 0, uppercase: false, maxLines, color, opacity: 1
    };
    y += h;
    return el;
  });
  return parseDesignSpec({
    version: 1,
    kind: 'INVITATION',
    canvas: { preset: presetId, width: W, height: H },
    background: '#000000',
    backgroundMedia: imageKey,
    palette: { background: '#000000', primary: ink.strong, accent: ink.accent, text: ink.strong },
    elements: [
      { type: 'qr', purpose: 'INVITATION', x: m, y: bottom, size: qr, padding: 0.07, radius: 22 },
      ...texts
    ],
    meta: { generator: 'UPLOAD' }
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
      { type: 'rect', x: panelX, y: panelY, w: panelW, h: panelH, radius: Math.round(0.03 * W), fill: '#FFFFFF', opacity: 0.94, strokeWidth: 0 },
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
  const spec = dynamic
    ? await (async () => {
        const { width: W, height: H } = CANVAS_PRESETS[presetFor(media.width, media.height)];
        return buildDynamicUploadedSpec(input.imageKey, media.width, media.height, await isLightAtBottom(input.imageKey, W, H));
      })()
    : buildUploadedSpec(input.imageKey, media.width, media.height);
  return Template.create({
    name: input.name?.trim() || `Uploaded template ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
    ...(input.categoryId ? { categoryId: new mongoose.Types.ObjectId(input.categoryId) } : {}),
    ...(input.subcategoryId ? { subcategoryId: new mongoose.Types.ObjectId(input.subcategoryId) } : {}),
    previewImageKey: input.imageKey,
    cardDesign: 'CUSTOM',
    kind: 'INVITATION',
    designSpec: spec,
    // lets the Templates screen tell an uploaded design from an AI-made one
    templateData: { uploaded: true, ...(dynamic ? { dynamicDetails: true } : {}) },
    ownerId: new mongoose.Types.ObjectId(actor.userId),
    // an organizer's upload is private to them; an admin's is shared: every organizer can use it (for its category / subcategory)
    isSystemTemplate: dynamic,
    isPublished: true,
    isActive: true
  });
}
