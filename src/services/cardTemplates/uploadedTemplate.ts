import { canUseCategory } from '../category.service';
import mongoose from 'mongoose';
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

export class UploadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function createUploadedTemplate(actor: { userId: string }, input: { name: string; imageKey: string; categoryId?: string; subcategoryId?: string }) {
  const mediaId = mediaIdFromKey(input.imageKey);
  if (!mediaId) throw new UploadError(400, 'Upload the design as an image first');
  // the image must be one this person uploaded as a template: nobody can build a template out of someone else's picture
  const media = await Media.findOne({ _id: mediaId, ownerId: actor.userId, purpose: MediaPurpose.TEMPLATE }).select('width height').lean();
  if (!media) throw new UploadError(400, 'That image was not found. Upload it again.');
  // someone else's custom category is treated as missing
  if (input.categoryId && !(await canUseCategory(input.categoryId, input.subcategoryId, actor.userId))) throw new UploadError(400, 'That category was not found.');
  const spec = buildUploadedSpec(input.imageKey, media.width, media.height);
  return Template.create({
    name: input.name.trim(),
    ...(input.categoryId ? { categoryId: new mongoose.Types.ObjectId(input.categoryId) } : {}),
    ...(input.subcategoryId ? { subcategoryId: new mongoose.Types.ObjectId(input.subcategoryId) } : {}),
    previewImageKey: input.imageKey,
    cardDesign: 'CUSTOM',
    kind: 'INVITATION',
    designSpec: spec,
    // lets the Templates screen tell an uploaded design from an AI-made one
    templateData: { uploaded: true },
    ownerId: new mongoose.Types.ObjectId(actor.userId),
    // private to the person who uploaded it
    isSystemTemplate: false,
    isPublished: true,
    isActive: true
  });
}
