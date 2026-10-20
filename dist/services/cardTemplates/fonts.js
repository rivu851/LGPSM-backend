"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fontFileFor = exports.fontStack = exports.FALLBACK_FAMILIES = exports.FONT_DIR = void 0;
exports.ensureCardFonts = ensureCardFonts;
exports.measureText = measureText;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const sharp_1 = __importDefault(require("sharp"));
const assetPath_1 = require("../../utils/assetPath");
// Invitation text is drawn by sharp (libvips + librsvg + Pango). The server's own fonts are unpredictable: a bare
// container has almost none, and none of them cover the designers' typefaces or Bengali / Devanagari names. So the
// fonts the templates need ship with the app and are registered with the renderer once per process, through sharp's
// `fontfile` option, which needs no environment variable and no system configuration.
exports.FONT_DIR = (0, assetPath_1.assetPath)('cardTemplates', 'fonts');
// (family, weight) used by the designs -> file in FONT_DIR
const FONT_FILES = {
    'Inter:500': 'Inter-Medium.ttf',
    'Inter:600': 'Inter-SemiBold.ttf',
    'Inter:700': 'Inter-Bold.ttf',
    'Alexandria:400': 'Alexandria-Regular.ttf',
    'Alexandria:500': 'Alexandria-Medium.ttf',
    'Alkatra:600': 'Alkatra-SemiBold.ttf',
    'Ancizar Serif:400': 'AncizarSerif-Regular.ttf',
    'Alex Brush:400': 'AlexBrush-Regular.ttf',
    'Birthstone:400': 'Birthstone-Regular.ttf',
};
/** Families tried, in order, when a glyph is missing (Bengali and Devanagari names, for example). */
exports.FALLBACK_FAMILIES = ['Noto Sans Bengali', 'Noto Sans Devanagari', 'Inter'];
const fontStack = (family) => `${family}, ${exports.FALLBACK_FAMILIES.join(', ')}, sans-serif`;
exports.fontStack = fontStack;
const fontFileFor = (family, weight) => {
    const exact = FONT_FILES[`${family}:${weight}`];
    if (exact)
        return path_1.default.join(exports.FONT_DIR, exact);
    // nearest available weight of the same family
    const candidates = Object.keys(FONT_FILES).filter((k) => k.startsWith(`${family}:`));
    if (candidates.length === 0)
        return null;
    const best = candidates.sort((a, b) => Math.abs(+a.split(':')[1] - weight) - Math.abs(+b.split(':')[1] - weight))[0];
    return path_1.default.join(exports.FONT_DIR, FONT_FILES[best]);
};
exports.fontFileFor = fontFileFor;
let registration = null;
/** Registers every bundled font with the renderer. Safe to call repeatedly; the work happens once. */
function ensureCardFonts() {
    if (!registration) {
        registration = (async () => {
            if (!fs_1.default.existsSync(exports.FONT_DIR)) {
                console.warn('[cards] Bundled fonts not found at', exports.FONT_DIR, '- card text will use whatever fonts the system has');
                return;
            }
            for (const file of fs_1.default.readdirSync(exports.FONT_DIR).filter((f) => f.endsWith('.ttf'))) {
                try {
                    await (0, sharp_1.default)({ text: { text: 'a', fontfile: path_1.default.join(exports.FONT_DIR, file) } }).raw().toBuffer();
                }
                catch (err) {
                    console.warn(`[cards] Could not register font ${file}:`, err instanceof Error ? err.message : 'unknown error');
                }
            }
        })();
    }
    return registration;
}
const escapeMarkup = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const widthCache = new Map();
/** Width in pixels of `text` set in the given font at `size` px (ink width, which is what line fitting needs). */
async function measureText(text, family, weight, size) {
    if (!text)
        return 0;
    const key = `${family}|${weight}|${size}|${text}`;
    const cached = widthCache.get(key);
    if (cached !== undefined)
        return cached;
    await ensureCardFonts();
    const fontfile = (0, exports.fontFileFor)(family, weight);
    const markup = `<span font_family="${family}" font_weight="${weight}">${escapeMarkup(text)}</span>`;
    const info = await (0, sharp_1.default)({ text: { text: markup, font: `${family} ${size}`, ...(fontfile ? { fontfile } : {}), dpi: 72, rgba: true } })
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then((r) => r.info);
    if (widthCache.size > 5000)
        widthCache.clear();
    widthCache.set(key, info.width);
    return info.width;
}
