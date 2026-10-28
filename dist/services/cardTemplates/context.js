"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardHostName = cardHostName;
exports.loadCardContext = loadCardContext;
const Template_1 = require("../../models/Template");
const Category_1 = require("../../models/Category");
const User_1 = require("../../models/User");
const designs_1 = require("./designs");
const designSpec_1 = require("./designSpec");
/**
 * Everything about an event's *type* that card rendering needs, looked up once per send rather than per guest:
 * the category and subcategory names, and the design (the chosen template's, else the one that suits the type).
 */
/** The host printed on invitation cards: the organiser's organisation, never the person's own name (blank when unset). */
function cardHostName(organizer) {
    return organizer?.profile?.organizationName?.trim() || undefined;
}
async function loadCardContext(event) {
    const [template, category] = await Promise.all([
        event.templateId ? Template_1.Template.findById(event.templateId).select('cardDesign designSpec ownerId isSystemTemplate isPublished isActive').lean() : null,
        event.categoryId ? Category_1.Category.findById(event.categoryId).select('name subcategories').lean() : null
    ]);
    const subcategory = category?.subcategories?.find((s) => String(s._id) === String(event.subcategoryId));
    const categoryName = category?.name;
    const subcategoryName = subcategory?.name;
    // A custom design is only drawn for an event it may serve: the designers'/admin's published templates for anyone,
    // an organizer's own template for that organizer's events. Anything else (another organizer's design, a deleted or
    // unreadable one) falls back to the design that suits the event type, so a card is always produced.
    let designSpec;
    let templateDesign = template?.cardDesign;
    if (template?.cardDesign === 'CUSTOM') {
        const usable = template.isActive !== false &&
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
