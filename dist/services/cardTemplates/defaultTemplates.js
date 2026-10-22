"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TEMPLATES = void 0;
exports.planDefaultTemplates = planDefaultTemplates;
exports.installDefaultTemplates = installDefaultTemplates;
const mongoose_1 = __importDefault(require("mongoose"));
const sharp_1 = __importDefault(require("sharp"));
const qrcode_1 = __importDefault(require("qrcode"));
const Category_1 = require("../../models/Category");
const Template_1 = require("../../models/Template");
const Media_1 = require("../../models/Media");
const renderer_1 = require("./renderer");
exports.DEFAULT_TEMPLATES = [
    { key: 'corporate-awards', name: 'Corporate Awards', cardDesign: 'CORPORATE_V1', category: 'Corporate', subcategory: 'Awards & Recognition' },
    { key: 'leadership-summit', name: 'Leadership Summit', cardDesign: 'CORPORATE_V2', category: 'Corporate', subcategory: 'Conference & Summit' },
    { key: 'tech-conference', name: 'Tech Conference', cardDesign: 'CORPORATE_V2', category: 'Technology' },
    { key: 'wedding-reception', name: 'Wedding Reception', cardDesign: 'WEDDING', category: 'Personal', subcategory: 'Wedding' },
    { key: 'rice-ceremony', name: 'Rice Ceremony', cardDesign: 'RICE_CEREMONY', category: 'Personal', subcategory: 'Rice Ceremony' },
    { key: 'birthday-party', name: 'Birthday Party', cardDesign: 'BIRTHDAY', category: 'Personal', subcategory: 'Birthday' },
    { key: 'general-event', name: 'General Event', cardDesign: 'CORPORATE_V2', category: 'General' }
];
const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
const findCategory = (cats, name) => cats.find((c) => same(c.name, name));
/** What installing would do, without changing anything. */
async function planDefaultTemplates() {
    const categories = await Category_1.Category.find({}).select('name subcategories').lean();
    const templates = await Template_1.Template.find({ isActive: { $ne: false } }).select('cardDesign categoryId subcategoryId').lean();
    const plan = { templatesToCreate: [], templatesPresent: [], categoriesToCreate: [], subcategoriesToCreate: [] };
    const plannedCategories = new Set();
    const plannedSubs = new Set();
    for (const spec of exports.DEFAULT_TEMPLATES) {
        const category = findCategory(categories, spec.category);
        const sub = spec.subcategory ? category?.subcategories?.find((s) => same(s.name, spec.subcategory)) : undefined;
        if (!category && !plannedCategories.has(spec.category.toLowerCase())) {
            plannedCategories.add(spec.category.toLowerCase());
            plan.categoriesToCreate.push(spec.category);
        }
        if (spec.subcategory && !sub && !plannedSubs.has(`${spec.category}/${spec.subcategory}`.toLowerCase())) {
            plannedSubs.add(`${spec.category}/${spec.subcategory}`.toLowerCase());
            // a brand-new category is created together with its subcategories, so only report subcategories of existing categories
            if (category)
                plan.subcategoriesToCreate.push({ category: spec.category, subcategory: spec.subcategory });
        }
        const exists = !!category &&
            templates.some((t) => t.cardDesign === spec.cardDesign &&
                String(t.categoryId || '') === String(category._id) &&
                String(t.subcategoryId || '') === String(sub?._id || ''));
        if (exists)
            plan.templatesPresent.push(spec.name);
        else
            plan.templatesToCreate.push({ name: spec.name, cardDesign: spec.cardDesign, category: spec.category, subcategory: spec.subcategory });
    }
    return plan;
}
// A small JPEG of the design with the designers' sample text, stored as media so web and mobile can show it
async function storePreview(spec, ownerId) {
    if (!(0, renderer_1.isTemplateDesign)(spec.cardDesign))
        throw new Error(`No artwork for design ${spec.cardDesign}`);
    const originalName = `default-template:${spec.key}`;
    const existing = await Media_1.Media.findOne({ purpose: Media_1.MediaPurpose.TEMPLATE, originalName }).select('_id');
    if (existing)
        return `media:${existing._id}`;
    const qr = await qrcode_1.default.toBuffer('https://lgpsm.example/sample-card-not-a-real-invitation', { errorCorrectionLevel: 'H', margin: 4, width: 400 });
    const png = await (0, renderer_1.renderTemplateCard)({ design: spec.cardDesign, texts: (0, renderer_1.sampleTexts)(spec.cardDesign), qr, scale: 1.5, useSamplePhoto: true });
    const { data, info } = await (0, sharp_1.default)(png).jpeg({ quality: 86, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    const media = await Media_1.Media.create({
        ownerId: new mongoose_1.default.Types.ObjectId(ownerId),
        purpose: Media_1.MediaPurpose.TEMPLATE,
        contentType: 'image/jpeg',
        size: info.size,
        width: info.width,
        height: info.height,
        originalName,
        data
    });
    return `media:${media._id}`;
}
async function installDefaultTemplates(ownerId) {
    const plan = await planDefaultTemplates();
    const created = [];
    for (const spec of exports.DEFAULT_TEMPLATES) {
        if (!plan.templatesToCreate.some((t) => t.name === spec.name))
            continue;
        // category (with the subcategory it needs), created only when absent
        let category = await Category_1.Category.findOne({ name: new RegExp(`^${spec.category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
        if (!category) {
            category = await Category_1.Category.create({ name: spec.category, isActive: true, subcategories: spec.subcategory ? [{ name: spec.subcategory, isActive: true }] : [] });
        }
        let subcategoryId;
        if (spec.subcategory) {
            let sub = category.subcategories.find((s) => same(s.name, spec.subcategory));
            if (!sub) {
                category.subcategories.push({ name: spec.subcategory, isActive: true });
                await category.save();
                sub = category.subcategories.find((s) => same(s.name, spec.subcategory));
            }
            subcategoryId = sub?._id;
        }
        // Another admin may have installed it a moment ago
        const duplicate = await Template_1.Template.exists({ cardDesign: spec.cardDesign, categoryId: category._id, ...(subcategoryId ? { subcategoryId } : { subcategoryId: { $exists: false } }), isActive: { $ne: false } });
        if (duplicate)
            continue;
        await Template_1.Template.create({
            name: spec.name,
            categoryId: category._id,
            ...(subcategoryId ? { subcategoryId } : {}),
            cardDesign: spec.cardDesign,
            previewImageKey: await storePreview(spec, ownerId),
            isSystemTemplate: true,
            isPublished: true,
            isActive: true
        });
        created.push(spec.name);
    }
    return { ...plan, created };
}
