import { Template } from '../../models/Template';
import { generateQRCodeDataURL } from '../../utils/qr.util';
import { previewSampleUrl } from '../../utils/qrPayload';
import { resolveImageKeyBase64 } from '../../utils/resolveImageBase64';
import { invitationCardService } from '../invitationCard.service';
import { resolveCardDesign } from './designs';
import { safeParseDesignSpec } from './designSpec';
import { templateVisibleTo } from '../template.service';

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
export async function renderTemplatePreview(templateId: string | null, input: TemplatePreviewInput, isAdmin: boolean, userId?: string): Promise<Buffer> {
  // With no template chosen the card still gets the design that suits the event type, exactly as it will when sent
  const template = templateId ? await Template.findOne({ _id: templateId, isActive: { $ne: false } }).select('cardDesign isPublished isSystemTemplate isActive ownerId kind designSpec').lean() : null;
  // organizers only see what the template list shows them: published templates and their own, never another organizer's
  if (templateId && (!template || !templateVisibleTo(template as any, { userId, isAdmin }))) throw new Error('TEMPLATE_NOT_FOUND');
  // a custom design is drawn from its stored specification
  const spec = template?.cardDesign === 'CUSTOM' ? safeParseDesignSpec(template.designSpec) : null;
  if (template?.cardDesign === 'CUSTOM' && !spec?.ok) throw new Error('TEMPLATE_NOT_USABLE');

  const cardDesign = resolveCardDesign({
    templateDesign: template?.cardDesign,
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
    // This is a preview of the template, so the designers' sample photo stands in until an image is uploaded
    isPreview: true,
    qrDataUrl: await generateQRCodeDataURL(invitationUrl),
    invitationUrl,
    cardDesign: spec?.ok ? 'CUSTOM' : cardDesign,
    designSpec: spec?.ok ? spec.spec : undefined
  });
}
