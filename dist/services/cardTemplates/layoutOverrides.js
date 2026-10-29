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
    // Event titles are user supplied and can be much longer than the sample headings. Give them enough lines and a
    // smaller floor so the actual event name stays inside the card instead of spilling past its rounded frame.
    // The title area in the artwork is visually too close to the card frame for real event names. Reduce its usable
    // width (including the generated box-width floor) so long titles wrap inside a padded text column.
    CORPORATE_V1: { title: { boxWidth: 290, maxWidth: 290, maxLines: 2, minSize: 14 } },
    CORPORATE_V2: { datePill: { cx: 214, maxWidth: 262 }, title: { boxWidth: 290, maxWidth: 290, maxLines: 2, minSize: 14 } },
    // These slots were drawn for one line, with the next element right below; a second line is centred on the designed line, so
    // it spilled over the neighbours ("Please join us…", "Birthday Party", "of our beloved child", the wedding sub-line and the
    // address pin). They stay on one line, shrinking to the slot's minimum size and ending in "…" only as a last resort.
    BIRTHDAY: { honoree: { maxLines: 1 } },
    WEDDING: { names: { maxLines: 1 }, subline: { maxLines: 1 }, address: { maxLines: 1 } },
    RICE_CEREMONY: { honoree: { maxLines: 1 } },
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
