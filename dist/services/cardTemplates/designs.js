"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CARD_DESIGN = void 0;
exports.resolveCardDesign = resolveCardDesign;
const Template_1 = require("../../models/Template");
const RULES = [
    { design: 'BIRTHDAY', test: /\b(birthday|bday|b['’]day|janmadin|jonmodin)\b/i },
    { design: 'RICE_CEREMONY', test: /(rice\s*ceremony|annaprasan|annaprashan|mukhe\s*bhaat|mukhebhat|first\s*rice)/i },
    { design: 'WEDDING', test: /(wedding|reception|marriage|engagement|sangeet|haldi|mehend|mehndi|anniversary|bou\s*bhat|ring\s*ceremony|shaadi|sagai)/i },
    { design: 'CORPORATE_V1', test: /(award|recognition|felicitation|excellence|honou?r)/i },
];
exports.DEFAULT_CARD_DESIGN = 'CORPORATE_V2';
function match(text) {
    for (const rule of RULES)
        if (rule.test.test(text))
            return rule.design;
    return null;
}
function resolveCardDesign(options) {
    const chosen = options.templateDesign;
    if (chosen && Template_1.CARD_DESIGNS.includes(chosen))
        return chosen;
    // The specific type (subcategory, then category) is a stronger signal than words that happen to be in a title
    return match(options.subcategoryName || '') || match(options.categoryName || '') || match(options.title || '') || exports.DEFAULT_CARD_DESIGN;
}
