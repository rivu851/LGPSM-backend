import { CARD_LAYOUTS, CardLayout, TextSlotLayout } from './layouts.generated';

/**
 * Adjustments to the generated layouts (layouts.generated.ts is rebuilt from the Figma file, so changes live here).
 *
 * The designers centred the date text on the whole pill, but the artwork prints a calendar icon at the pill's left end (it ends
 * about x=66 of the 393-wide card). A date with a year is longer than the sample, so it grew left into the icon. The text is now
 * centred in the free space to the right of the icon and kept at least ~16px (card scale) away from it.
 */
const SLOT_OVERRIDES: Record<string, Record<string, Partial<TextSlotLayout>>> = {
  CORPORATE_V2: { datePill: { cx: 214, maxWidth: 262 } },
};

export const LAYOUTS: Record<string, CardLayout> = Object.fromEntries(
  Object.entries(CARD_LAYOUTS).map(([design, layout]) => {
    const patch = SLOT_OVERRIDES[design];
    if (!patch) return [design, layout];
    const texts = { ...layout.texts };
    for (const [slot, over] of Object.entries(patch)) if (texts[slot]) texts[slot] = { ...texts[slot], ...over };
    return [design, { ...layout, texts }];
  })
);
