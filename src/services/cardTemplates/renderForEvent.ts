import sharp from 'sharp';
import QRCode from 'qrcode';
import { Template } from '../../models/Template';
import { User } from '../../models/User';
import { findManageableEvent } from '../../utils/eventAccess';
import { previewSampleUrl } from '../../utils/qrPayload';
import { buildInvitationContent } from '../../utils/invitationContent';
import { resolveImageKeyBase64 } from '../../utils/resolveImageBase64';
import { templateVisibleTo } from '../template.service';
import { buildSpecTexts } from './content';
import { safeParseDesignSpec } from './designSpec';
import { cardHostName } from './context';
import { cardGuestLines } from '../../utils/cardInfo';
import { renderDesignSpec } from './specRenderer';

export interface RenderForEventInput {
  templateId: string;
  eventId: string;
  /** Poster QR target. Only encoded into the code, never fetched. */
  registrationUrl?: string;
  format?: 'png' | 'jpeg';
  userId: string;
  isAdmin: boolean;
}

export interface RenderForEventResult {
  body: Buffer;
  contentType: string;
  /** SAMPLE: a placeholder code that check-in rejects. LINK: the poster's registration link. NONE: no QR was drawn. */
  qr: 'SAMPLE' | 'LINK' | 'NONE';
  warnings: string[];
  width: number;
  height: number;
}

const dataUrlToBuffer = (dataUrl?: string): Buffer | undefined => {
  const match = dataUrl ? /^data:[^;]+;base64,(.+)$/.exec(dataUrl) : null;
  return match ? Buffer.from(match[1], 'base64') : undefined;
};

/**
 * A custom template drawn with a real event's details at full canvas size, as PNG or JPEG.
 * Invitation templates carry a clearly marked sample QR here: a guest's own QR exists only in the invitation
 * workflow, which issues and renders it per attendee. Poster templates carry the registration link when one is given.
 */
export async function renderTemplateForEvent(input: RenderForEventInput): Promise<RenderForEventResult> {
  const template = await Template.findOne({ _id: input.templateId, isActive: { $ne: false } }).select('cardDesign isPublished isSystemTemplate isActive ownerId kind designSpec').lean();
  if (!template || !templateVisibleTo(template as any, { userId: input.userId, isAdmin: input.isAdmin })) throw new Error('TEMPLATE_NOT_FOUND');
  const parsed = template.cardDesign === 'CUSTOM' ? safeParseDesignSpec(template.designSpec) : null;
  if (!parsed?.ok) throw new Error('TEMPLATE_NOT_USABLE');

  const event = await findManageableEvent(input.eventId, input.userId, input.isAdmin ? 'ADMIN' : undefined);
  if (!event) throw new Error('EVENT_NOT_FOUND');

  const organizer = event.organizerId ? await User.findById(event.organizerId).select('profile.organizationName').lean() : null;
  const content = buildInvitationContent(event as any, [], null); // the same venue wording the invitation workflow prints
  const texts = buildSpecTexts({
    title: event.title,
    description: (event as any).description,
    startIso: event.schedule?.start,
    endIso: event.schedule?.end,
    venue: content.venue,
    locationSub: content.locationSub,
    isVirtual: (event as any).format === 'VIRTUAL',
    organizerName: cardHostName(organizer as any),
    invitee: parsed.spec.kind === 'INVITATION' ? cardGuestLines(null, (event as any).cardInfo) : { name: undefined }
  });

  let qr: Buffer | undefined;
  let qrKind: RenderForEventResult['qr'] = 'NONE';
  if (parsed.spec.kind === 'POSTER') {
    if (input.registrationUrl) {
      qr = await QRCode.toBuffer(input.registrationUrl, { errorCorrectionLevel: 'H', margin: 4, width: 640 });
      qrKind = 'LINK';
    }
  } else {
    qr = await QRCode.toBuffer(previewSampleUrl(), { errorCorrectionLevel: 'H', margin: 4, width: 640 });
    qrKind = 'SAMPLE';
  }

  const image = dataUrlToBuffer(await resolveImageKeyBase64((event as any).media?.logoKey));
  const rendered = await renderDesignSpec({ spec: parsed.spec, texts, qr, photo: image, logo: image });
  if (input.format === 'jpeg') {
    const body = await sharp(rendered.png).flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    return { body, contentType: 'image/jpeg', qr: qrKind, warnings: rendered.warnings, width: rendered.width, height: rendered.height };
  }
  return { body: rendered.png, contentType: 'image/png', qr: qrKind, warnings: rendered.warnings, width: rendered.width, height: rendered.height };
}
