import { Template } from '../../models/Template';
import { generateQRCodeDataURL } from '../../utils/qr.util';
import { previewSampleUrl } from '../../utils/qrPayload';
import { resolveImageKeyBase64 } from '../../utils/resolveImageBase64';
import { invitationCardService } from '../invitationCard.service';
import { resolveCardDesign } from './designs';

export interface TemplatePreviewInput {
  title?: string;
  startIso?: string;
  endIso?: string;
  venue?: string;
  locationSub?: string;
  isVirtual?: boolean;
  categoryName?: string;
  subcategoryName?: string;
  logoKey?: string;
  guestName?: string;
  companyName?: string;
}

/**
 * The card a template produces for the event being entered, with a placeholder guest and a clearly marked sample QR.
 * Lets the Add Event form show the real card (and the wording written for this kind of event) before anything is saved.
 */
export async function renderTemplatePreview(templateId: string, input: TemplatePreviewInput, isAdmin: boolean): Promise<Buffer> {
  const template = await Template.findOne({ _id: templateId, isActive: { $ne: false } }).select('cardDesign isPublished').lean();
  // organizers only see published templates, exactly as in the template list
  if (!template || (template.isPublished === false && !isAdmin)) throw new Error('TEMPLATE_NOT_FOUND');

  const cardDesign = resolveCardDesign({
    templateDesign: template.cardDesign,
    categoryName: input.categoryName,
    subcategoryName: input.subcategoryName,
    title: input.title
  });
  const invitationUrl = previewSampleUrl();
  return invitationCardService.generateInvitationCardPNG({
    invitee: { name: input.guestName?.trim() || 'Guest Name', companyName: input.companyName?.trim() || '' },
    event: {
      title: input.title?.trim() || 'Your event title',
      venue: input.venue,
      locationSub: input.locationSub,
      startIso: input.startIso,
      endIso: input.endIso,
      categoryName: input.categoryName,
      subcategoryName: input.subcategoryName,
      isVirtual: input.isVirtual,
      photoBase64: input.logoKey ? await resolveImageKeyBase64(input.logoKey) : undefined
    },
    sessions: [],
    qrDataUrl: await generateQRCodeDataURL(invitationUrl),
    invitationUrl,
    cardDesign
  });
}
