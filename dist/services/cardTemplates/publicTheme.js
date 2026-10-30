"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicThemeFor = publicThemeFor;
// Taken from the artwork of each fixed design (src/assets/cardTemplates/*/background.png)
const FIXED = {
    CORPORATE_V1: { background: '#EEF2F7', primary: '#1B4B8F', accent: '#F08A1C', ink: '#14233C', heading: 'sans' },
    CORPORATE_V2: { background: '#F6F7F9', primary: '#E3340F', accent: '#123C8F', ink: '#15191C', heading: 'sans' },
    WEDDING: { background: '#F7F5F0', primary: '#2B2B2B', accent: '#A8946A', ink: '#202020', heading: 'serif' },
    RICE_CEREMONY: { background: '#FFF8EA', primary: '#660410', accent: '#C98A3B', ink: '#3A0A0F', heading: 'serif' },
    BIRTHDAY: { background: '#FBF6EC', primary: '#794807', accent: '#C9A24B', ink: '#3B2A10', heading: 'serif' },
    CLASSIC: { background: '#F6F7F9', primary: '#E3340F', accent: '#123C8F', ink: '#15191C', heading: 'sans' }
};
const SERIF_FONTS = new Set(['Playfair Display', 'Ancizar Serif', 'Alex Brush', 'Birthstone']);
const HEX = /^#[0-9a-fA-F]{6}$/;
function publicThemeFor(design, spec) {
    if (design === 'CUSTOM' && spec?.palette && ['background', 'primary', 'accent', 'text'].every((k) => HEX.test(String(spec.palette?.[k])))) {
        const title = spec.elements?.find((e) => e?.type === 'text' && e.role === 'title');
        return {
            design,
            background: spec.palette.background,
            primary: spec.palette.primary,
            accent: spec.palette.accent,
            ink: spec.palette.text,
            heading: title && SERIF_FONTS.has(title.fontFamily) ? 'serif' : 'sans'
        };
    }
    return { design, ...(FIXED[design] || FIXED.CORPORATE_V2) };
}
