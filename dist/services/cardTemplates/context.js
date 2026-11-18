"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardCarriesQr = void 0;
exports.cardHostName = cardHostName;
exports.loadCardContext = loadCardContext;
const uploadedTemplate_1 = require("./uploadedTemplate");
const Template_1 = require("../../models/Template");
const Category_1 = require("../../models/Category");
const User_1 = require("../../models/User");
const designs_1 = require("./designs");
const designSpec_1 = require("./designSpec");
const masterCard_1 = require("../../constants/masterCard");
/**
 * Everything about an event's *type* that card rendering needs, looked up once per send rather than per guest:
 * the category and subcategory names, and the design (the chosen template's, else the one that suits the type).
 */
/** The host printed on invitation cards: the organiser's organisation, never the person's own name (blank when unset). */
function cardHostName(organizer) {
    return organizer?.profile?.organizationName?.trim() || undefined;
}
async function loadCardContext(event) {
    const [rawTemplate, category] = await Promise.all([
        event.templateId ? Template_1.Template.findById(event.templateId).select('cardDesign designSpec ownerId isSystemTemplate isPublished isActive templateData').lean() : null,
        event.categoryId ? Category_1.Category.findById(event.categoryId).select('name subcategories').lean() : null
    ]);
    // (an old admin upload has its wording read once, so real sends and the event's card preview replace it just like the form's preview)
    const template = await (0, uploadedTemplate_1.withCurrentLayout)(rawTemplate);
    const subcategory = category?.subcategories?.find((s) => String(s._id) === String(event.subcategoryId));
    const categoryName = category?.name;
    const subcategoryName = subcategory?.name;
    // A custom design is only drawn for an event it may serve: the designers'/admin's published templates for anyone,
    // an organizer's own template for that organizer's events. Anything else (another organizer's design, a deleted or
    // unreadable one) falls back to the design that suits the event type, so a card is always produced.
    let designSpec;
    let templateDesign = template?.cardDesign;
    // (while the master card is the only shared design, only an organizer's own uploaded design is drawn besides it, for that organizer's events)
    if (template?.cardDesign === 'CUSTOM' && (!(0, masterCard_1.masterCardOnly)() || (!!template.ownerId && String(template.ownerId) === String(event.organizerId)))) {
        // (a "retired" template is no longer offered in the template list, but the events that already use it keep their card)
        const usable = (template.isActive !== false || template.templateData?.retired === true) &&
            (!template.ownerId || (template.isSystemTemplate && template.isPublished !== false) || String(template.ownerId) === String(event.organizerId));
        const parsed = usable ? (0, designSpec_1.safeParseDesignSpec)(template.designSpec) : null;
        if (parsed?.ok && parsed.spec.kind === 'INVITATION')
            designSpec = parsed.spec;
        else {
            templateDesign = undefined;
            console.warn('[cards] A custom template could not be used for an event; using the default design for its type');
        }
    }
    const organizer = designSpec && event.organizerId ? await User_1.User.findById(event.organizerId).select('profile.organizationName').lean() : null;
    return {
        cardDesign: designSpec ? 'CUSTOM' : (0, designs_1.resolveCardDesign)({ templateDesign, categoryName, subcategoryName, title: event.title }),
        categoryName,
        subcategoryName,
        designSpec,
        organizerName: cardHostName(organizer)
    };
}
/**
 * Does the card itself carry the guest's entry QR? Not when the organizer turned the QR off on the card, and not on an organizer's own
 * static design (the picture is sent exactly as it is). Then the guest's email and invitation page show the QR on its own.
 */
const cardCarriesQr = (event, context) => event.cardDisplay?.qr !== false && !context.designSpec?.meta?.plain;
exports.cardCarriesQr = cardCarriesQr;
