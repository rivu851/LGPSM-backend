import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { assetPath } from '../../utils/assetPath';

// Invitation text is drawn by sharp (libvips + librsvg + Pango). The server's own fonts are unpredictable: a bare
// container has almost none, and none of them cover the designers' typefaces or Bengali / Devanagari names. So the
// fonts the templates need ship with the app and are registered with the renderer once per process, through sharp's
// `fontfile` option, which needs no environment variable and no system configuration.

export const FONT_DIR = assetPath('cardTemplates', 'fonts');

// (family, weight) used by the designs -> file in FONT_DIR
const FONT_FILES: Record<string, string> = {
  'Inter:500': 'Inter-Medium.ttf',
  'Inter:600': 'Inter-SemiBold.ttf',
  'Inter:700': 'Inter-Bold.ttf',
  'Alexandria:400': 'Alexandria-Regular.ttf',
  'Alexandria:500': 'Alexandria-Medium.ttf',
  'Alkatra:600': 'Alkatra-SemiBold.ttf',
  'Ancizar Serif:400': 'AncizarSerif-Regular.ttf',
  'Alex Brush:400': 'AlexBrush-Regular.ttf',
  'Birthstone:400': 'Birthstone-Regular.ttf',
  'Playfair Display:400': 'PlayfairDisplay-Regular.ttf',
  'Playfair Display:600': 'PlayfairDisplay-SemiBold.ttf',
  'Playfair Display:700': 'PlayfairDisplay-Bold.ttf',
  'Manrope:500': 'Manrope-Medium.ttf',
  'Manrope:700': 'Manrope-Bold.ttf',
};

/** Families tried, in order, when a glyph is missing (Bengali and Devanagari names, for example). */
export const FALLBACK_FAMILIES = ['Noto Sans Bengali', 'Noto Sans Devanagari', 'Inter'];

export const fontStack = (family: string) => `${family}, ${FALLBACK_FAMILIES.join(', ')}, sans-serif`;

export const fontFileFor = (family: string, weight: number): string | null => {
  const exact = FONT_FILES[`${family}:${weight}`];
  if (exact) return path.join(FONT_DIR, exact);
  // nearest available weight of the same family
  const candidates = Object.keys(FONT_FILES).filter((k) => k.startsWith(`${family}:`));
  if (candidates.length === 0) return null;
  const best = candidates.sort((a, b) => Math.abs(+a.split(':')[1] - weight) - Math.abs(+b.split(':')[1] - weight))[0];
  return path.join(FONT_DIR, FONT_FILES[best]);
};

let registration: Promise<void> | null = null;

/** Registers every bundled font with the renderer. Safe to call repeatedly; the work happens once. */
export function ensureCardFonts(): Promise<void> {
  if (!registration) {
    registration = (async () => {
      if (!fs.existsSync(FONT_DIR)) {
        console.warn('[cards] Bundled fonts not found at', FONT_DIR, '- card text will use whatever fonts the system has');
        return;
      }
      for (const file of fs.readdirSync(FONT_DIR).filter((f) => f.endsWith('.ttf'))) {
        try {
          await sharp({ text: { text: 'a', fontfile: path.join(FONT_DIR, file) } }).raw().toBuffer();
        } catch (err) {
          console.warn(`[cards] Could not register font ${file}:`, err instanceof Error ? err.message : 'unknown error');
        }
      }
    })();
  }
  return registration;
}

const escapeMarkup = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const widthCache = new Map<string, number>();

/** Width in pixels of `text` set in the given font at `size` px (ink width, which is what line fitting needs). */
export async function measureText(text: string, family: string, weight: number, size: number): Promise<number> {
  if (!text) return 0;
  const key = `${family}|${weight}|${size}|${text}`;
  const cached = widthCache.get(key);
  if (cached !== undefined) return cached;
  await ensureCardFonts();
  const fontfile = fontFileFor(family, weight);
  const markup = `<span font_family="${family}" font_weight="${weight}">${escapeMarkup(text)}</span>`;
  const info = await sharp({ text: { text: markup, font: `${family} ${size}`, ...(fontfile ? { fontfile } : {}), dpi: 72, rgba: true } })
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then((r) => r.info);
  if (widthCache.size > 5000) widthCache.clear();
  widthCache.set(key, info.width);
  return info.width;
}
