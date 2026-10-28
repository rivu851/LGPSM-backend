"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LAYOUTS = void 0;
const layouts_generated_1 = require("./layouts.generated");
/**
 * Adjustments to the generated layouts (layouts.generated.ts is rebuilt from the Figma file, so changes live here).
 *
 * The designers centred the date text on the whole pill, but the artwork prints a calendar icon at the pill's left end (it ends
 * about x=66 of the 393-wide card). A date with a year is longer than the sample, so it grew left into the icon. The text is now
 * centred in the free space to the right of the icon and kept at least ~16px (card scale) away from it.
 */
const SLOT_OVERRIDES = {
    CORPORATE_V2: { datePill: { cx: 214, maxWidth: 262 } },
};
exports.LAYOUTS = Object.fromEntries(Object.entries(layouts_generated_1.CARD_LAYOUTS).map(([design, layout]) => {
    const patch = SLOT_OVERRIDES[design];
    if (!patch)
        return [design, layout];
    const texts = { ...layout.texts };
    for (const [slot, over] of Object.entries(patch))
        if (texts[slot])
            texts[slot] = { ...texts[slot], ...over };
    return [design, { ...layout, texts }];
}));
