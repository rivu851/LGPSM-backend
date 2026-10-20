"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadCardContext = loadCardContext;
const Template_1 = require("../../models/Template");
const Category_1 = require("../../models/Category");
const designs_1 = require("./designs");
/**
 * Everything about an event's *type* that card rendering needs, looked up once per send rather than per guest:
 * the category and subcategory names, and the design (the chosen template's, else the one that suits the type).
 */
async function loadCardContext(event) {
    const [template, category] = await Promise.all([
        event.templateId ? Template_1.Template.findById(event.templateId).select('cardDesign').lean() : null,
        event.categoryId ? Category_1.Category.findById(event.categoryId).select('name subcategories').lean() : null
    ]);
    const subcategory = category?.subcategories?.find((s) => String(s._id) === String(event.subcategoryId));
    const categoryName = category?.name;
    const subcategoryName = subcategory?.name;
    return {
        cardDesign: (0, designs_1.resolveCardDesign)({ templateDesign: template?.cardDesign, categoryName, subcategoryName, title: event.title }),
        categoryName,
        subcategoryName
    };
}
