"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderTemplatePreview = renderTemplatePreview;
const Template_1 = require("../../models/Template");
const qr_util_1 = require("../../utils/qr.util");
const qrPayload_1 = require("../../utils/qrPayload");
const resolveImageBase64_1 = require("../../utils/resolveImageBase64");
const invitationCard_service_1 = require("../invitationCard.service");
const designs_1 = require("./designs");
const designSpec_1 = require("./designSpec");
const cardInfo_1 = require("../../utils/cardInfo");
const template_service_1 = require("../template.service");
/**
 * The card a template produces for the event being entered, with a placeholder guest and a clearly marked sample QR.
 * Lets the Add Event form show the real card (and the wording written for this kind of event) before anything is saved.
 */
async function renderTemplatePreview(templateId, input, isAdmin, userId) {
    // With no template chosen the card still gets the design that suits the event type, exactly as it will when sent
    const template = templateId ? await Template_1.Template.findOne({ _id: templateId, isActive: { $ne: false } }).select('cardDesign isPublished isSystemTemplate isActive ownerId kind designSpec').lean() : null;
    // organizers only see what the template list shows them: published templates and their own, never another organizer's
    if (templateId && (!template || !(0, template_service_1.templateVisibleTo)(template, { userId, isAdmin })))
        throw new Error('TEMPLATE_NOT_FOUND');
    // a custom design is drawn from its stored specification
    const spec = template?.cardDesign === 'CUSTOM' ? (0, designSpec_1.safeParseDesignSpec)(template.designSpec) : null;
    if (template?.cardDesign === 'CUSTOM' && !spec?.ok)
        throw new Error('TEMPLATE_NOT_USABLE');
    const cardDesign = (0, designs_1.resolveCardDesign)({
        templateDesign: template?.cardDesign,
        categoryName: input.categoryName,
        subcategoryName: input.subcategoryName,
        title: input.title
    });
    const invitationUrl = (0, qrPayload_1.previewSampleUrl)();
    return invitationCard_service_1.invitationCardService.generateInvitationCardPNG({
        // The Add/Edit Event form's "Additional Info" choice shows its sample lines until there are real guests
        invitee: input.cardInfo ? (0, cardInfo_1.cardGuestLines)(null, input.cardInfo) : { name: input.guestName?.trim() || 'Guest Name', companyName: input.companyName?.trim() || '' },
        event: {
            title: input.title?.trim() || 'Your event title',
            venue: input.venue,
            locationSub: input.locationSub,
            startIso: input.startIso,
            endIso: input.endIso,
            categoryName: input.categoryName,
            subcategoryName: input.subcategoryName,
            isVirtual: input.isVirtual,
            photoBase64: input.logoKey ? await (0, resolveImageBase64_1.resolveImageKeyBase64)(input.logoKey) : undefined
        },
        sessions: [],
        // This is a preview of the template, so the designers' sample photo stands in until an image is uploaded
        isPreview: true,
        qrDataUrl: await (0, qr_util_1.generateQRCodeDataURL)(invitationUrl),
        invitationUrl,
        cardDesign: spec?.ok ? 'CUSTOM' : cardDesign,
        designSpec: spec?.ok ? spec.spec : undefined
    });
}
