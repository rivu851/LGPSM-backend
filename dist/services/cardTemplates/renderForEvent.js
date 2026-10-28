"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderTemplateForEvent = renderTemplateForEvent;
const sharp_1 = __importDefault(require("sharp"));
const qrcode_1 = __importDefault(require("qrcode"));
const Template_1 = require("../../models/Template");
const User_1 = require("../../models/User");
const eventAccess_1 = require("../../utils/eventAccess");
const qrPayload_1 = require("../../utils/qrPayload");
const invitationContent_1 = require("../../utils/invitationContent");
const resolveImageBase64_1 = require("../../utils/resolveImageBase64");
const template_service_1 = require("../template.service");
const content_1 = require("./content");
const designSpec_1 = require("./designSpec");
const context_1 = require("./context");
const cardInfo_1 = require("../../utils/cardInfo");
const specRenderer_1 = require("./specRenderer");
const dataUrlToBuffer = (dataUrl) => {
    const match = dataUrl ? /^data:[^;]+;base64,(.+)$/.exec(dataUrl) : null;
    return match ? Buffer.from(match[1], 'base64') : undefined;
};
/**
 * A custom template drawn with a real event's details at full canvas size, as PNG or JPEG.
 * Invitation templates carry a clearly marked sample QR here: a guest's own QR exists only in the invitation
 * workflow, which issues and renders it per attendee. Poster templates carry the registration link when one is given.
 */
async function renderTemplateForEvent(input) {
    const template = await Template_1.Template.findOne({ _id: input.templateId, isActive: { $ne: false } }).select('cardDesign isPublished isSystemTemplate isActive ownerId kind designSpec').lean();
    if (!template || !(0, template_service_1.templateVisibleTo)(template, { userId: input.userId, isAdmin: input.isAdmin }))
        throw new Error('TEMPLATE_NOT_FOUND');
    const parsed = template.cardDesign === 'CUSTOM' ? (0, designSpec_1.safeParseDesignSpec)(template.designSpec) : null;
    if (!parsed?.ok)
        throw new Error('TEMPLATE_NOT_USABLE');
    const event = await (0, eventAccess_1.findManageableEvent)(input.eventId, input.userId, input.isAdmin ? 'ADMIN' : undefined);
    if (!event)
        throw new Error('EVENT_NOT_FOUND');
    const organizer = event.organizerId ? await User_1.User.findById(event.organizerId).select('profile.organizationName').lean() : null;
    const content = (0, invitationContent_1.buildInvitationContent)(event, [], null); // the same venue wording the invitation workflow prints
    const texts = (0, content_1.buildSpecTexts)({
        title: event.title,
        description: event.description,
        startIso: event.schedule?.start,
        endIso: event.schedule?.end,
        venue: content.venue,
        locationSub: content.locationSub,
        isVirtual: event.format === 'VIRTUAL',
        organizerName: (0, context_1.cardHostName)(organizer),
        invitee: parsed.spec.kind === 'INVITATION' ? (0, cardInfo_1.cardGuestLines)(null, event.cardInfo) : { name: undefined }
    });
    let qr;
    let qrKind = 'NONE';
    if (parsed.spec.kind === 'POSTER') {
        if (input.registrationUrl) {
            qr = await qrcode_1.default.toBuffer(input.registrationUrl, { errorCorrectionLevel: 'H', margin: 4, width: 640 });
            qrKind = 'LINK';
        }
    }
    else {
        qr = await qrcode_1.default.toBuffer((0, qrPayload_1.previewSampleUrl)(), { errorCorrectionLevel: 'H', margin: 4, width: 640 });
        qrKind = 'SAMPLE';
    }
    const image = dataUrlToBuffer(await (0, resolveImageBase64_1.resolveImageKeyBase64)(event.media?.logoKey));
    const rendered = await (0, specRenderer_1.renderDesignSpec)({ spec: parsed.spec, texts, qr, photo: image, logo: image });
    if (input.format === 'jpeg') {
        const body = await (0, sharp_1.default)(rendered.png).flatten({ background: '#ffffff' }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
        return { body, contentType: 'image/jpeg', qr: qrKind, warnings: rendered.warnings, width: rendered.width, height: rendered.height };
    }
    return { body: rendered.png, contentType: 'image/png', qr: qrKind, warnings: rendered.warnings, width: rendered.width, height: rendered.height };
}
