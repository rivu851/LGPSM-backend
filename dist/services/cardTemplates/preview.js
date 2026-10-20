"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderTemplatePreview = renderTemplatePreview;
const Template_1 = require("../../models/Template");
const qr_util_1 = require("../../utils/qr.util");
const qrPayload_1 = require("../../utils/qrPayload");
const resolveImageBase64_1 = require("../../utils/resolveImageBase64");
const invitationCard_service_1 = require("../invitationCard.service");
const designs_1 = require("./designs");
/**
 * The card a template produces for the event being entered, with a placeholder guest and a clearly marked sample QR.
 * Lets the Add Event form show the real card (and the wording written for this kind of event) before anything is saved.
 */
async function renderTemplatePreview(templateId, input, isAdmin) {
    const template = await Template_1.Template.findOne({ _id: templateId, isActive: { $ne: false } }).select('cardDesign isPublished').lean();
    // organizers only see published templates, exactly as in the template list
    if (!template || (template.isPublished === false && !isAdmin))
        throw new Error('TEMPLATE_NOT_FOUND');
    const cardDesign = (0, designs_1.resolveCardDesign)({
        templateDesign: template.cardDesign,
        categoryName: input.categoryName,
        subcategoryName: input.subcategoryName,
        title: input.title
    });
    const invitationUrl = (0, qrPayload_1.previewSampleUrl)();
    return invitationCard_service_1.invitationCardService.generateInvitationCardPNG({
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
            photoBase64: input.logoKey ? await (0, resolveImageBase64_1.resolveImageKeyBase64)(input.logoKey) : undefined
        },
        sessions: [],
        qrDataUrl: await (0, qr_util_1.generateQRCodeDataURL)(invitationUrl),
        invitationUrl,
        cardDesign
    });
}
