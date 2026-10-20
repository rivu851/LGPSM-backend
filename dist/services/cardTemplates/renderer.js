"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SOURCE_SCALE = exports.cardLayout = exports.DEFAULT_SCALE = exports.isTemplateDesign = exports.TEMPLATE_DESIGNS = void 0;
exports.renderTemplateCard = renderTemplateCard;
exports.sampleTexts = sampleTexts;
const fs_1 = __importDefault(require("fs"));
const sharp_1 = __importDefault(require("sharp"));
const layouts_generated_1 = require("./layouts.generated");
const fonts_1 = require("./fonts");
const assetPath_1 = require("../../utils/assetPath");
// Draws an invitation card from the designers' Figma template: the fixed artwork exported from Figma
// (scripts/figma-templates/build.js) with this event's content placed where the designers put it.
//
// Nothing here is guessed from a screenshot: slot positions, fonts, sizes, colours and baselines are read from the
// Figma file, so a card looks like the design. Text is fitted to its slot (wrapped, then shrunk down to a minimum),
// and anything that does not fit is shortened rather than overflowing the artwork.
exports.TEMPLATE_DESIGNS = ['CORPORATE_V1', 'CORPORATE_V2', 'WEDDING', 'RICE_CEREMONY', 'BIRTHDAY'];
const isTemplateDesign = (design) => !!design && exports.TEMPLATE_DESIGNS.includes(design);
exports.isTemplateDesign = isTemplateDesign;
const SOURCE_SCALE = 3; // the exported artwork is 3x the Figma frame (1179 x 2046)
exports.SOURCE_SCALE = SOURCE_SCALE;
exports.DEFAULT_SCALE = 2; // delivered cards are 786 x 1364: sharp on phones, small enough for email and WhatsApp
const EDGE_MARGIN = 24; // text never gets closer than this to the card edge (Figma px)
const MAX_TEXT_LENGTH = 160;
// Neutral colours for the photo frame when the organizer has not uploaded one
const PHOTO_FALLBACK = {
    BIRTHDAY: { fill: '#F3E3C3', ink: '#794807' },
    WEDDING: { fill: '#EFE9DD', ink: '#202020' },
    RICE_CEREMONY: { fill: '#F6E8D3', ink: '#660410' },
};
const escapeXml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// eslint-disable-next-line no-control-regex
const cleanText = (t) => t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);
const round = (n) => Math.round(n * 100) / 100;
const backgroundCache = new Map();
async function loadBackground(layout, scale) {
    const key = `${layout.design}@${scale}`;
    const cached = backgroundCache.get(key);
    if (cached)
        return cached;
    const file = (0, assetPath_1.assetPath)('cardTemplates', layout.background);
    if (!fs_1.default.existsSync(file))
        throw new Error(`Card artwork missing: ${layout.background}`);
    const width = Math.round(layout.width * scale);
    const height = Math.round(layout.height * scale);
    const buf = await (0, sharp_1.default)(file).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
    backgroundCache.set(key, buf);
    return buf;
}
// ---- text fitting ----
function maxWidthFor(layout, slot, reserve) {
    const symmetric = Math.min(2 * slot.cx, 2 * (layout.width - slot.cx)) - 2 * EDGE_MARGIN;
    // the designers' own box (or the artwork's content width, recorded per slot) wins; never wider than the card allows
    const limit = slot.maxWidth > 0 ? Math.min(slot.maxWidth, symmetric) : symmetric;
    // short slots (day numbers, months) keep their designed width as a floor so they never wrap
    return Math.max(limit - reserve, slot.boxWidth);
}
async function makeMeasurer(slot, words) {
    const at = (t, size) => (0, fonts_1.measureText)(t, slot.fontFamily, slot.fontWeight, size);
    const ref = slot.fontSize;
    const wordWidth = new Map();
    for (const w of new Set(words))
        wordWidth.set(w, await at(w, ref));
    const space = Math.max(0, (await at('n n', ref)) - (await at('nn', ref)));
    return {
        line: (ws, size) => ((ws.reduce((sum, w) => sum + (wordWidth.get(w) || 0), 0) + Math.max(0, ws.length - 1) * space) * size) / ref,
        exact: (text, size) => at(text, size),
    };
}
function wrapWords(words, size, maxWidth, m) {
    const lines = [];
    let current = [];
    for (const word of words) {
        if (current.length === 0 || m.line([...current, word], size) <= maxWidth)
            current.push(word);
        else {
            lines.push(current);
            current = [word];
        }
    }
    if (current.length)
        lines.push(current);
    // Two lines read better balanced than "a long first line and one orphan word": pick the split with the shortest widest line
    if (lines.length === 2 && words.length > 2) {
        let best = lines;
        let bestMax = Math.max(m.line(lines[0], size), m.line(lines[1], size));
        for (let i = 1; i < words.length; i++) {
            const a = words.slice(0, i);
            const b = words.slice(i);
            const wa = m.line(a, size);
            const wb = m.line(b, size);
            if (Math.max(wa, wb) < bestMax && wa <= maxWidth && wb <= maxWidth) {
                best = [a, b];
                bestMax = Math.max(wa, wb);
            }
        }
        return best;
    }
    return lines;
}
async function fitText(layout, slot, raw, reserve = 0) {
    const text = cleanText(raw);
    const words = text.split(' ').filter(Boolean);
    const maxWidth = maxWidthFor(layout, slot, reserve);
    const step = Math.max(0.5, slot.fontSize * 0.04);
    const m = await makeMeasurer(slot, words);
    const widthsOf = (lines, size) => lines.map((l) => m.line(l, size));
    const ok = (lines, size) => lines.length <= slot.maxLines && widthsOf(lines, size).every((w) => w <= maxWidth + 0.5);
    let size = slot.fontSize;
    let lines = wrapWords(words, size, maxWidth, m);
    // A slot the designers drew as one line stays one line: shrink a little (to 78%) before ever wrapping, so a
    // name that is slightly longer than the sample does not break into two lines and collide with what is below it.
    if (slot.designLines === 1 && slot.maxLines > 1 && lines.length > 1) {
        for (let s = slot.fontSize; s >= slot.fontSize * 0.78 && s >= slot.minSize; s = round(s - step)) {
            const attempt = wrapWords(words, s, maxWidth, m);
            if (attempt.length === 1 && ok(attempt, s)) {
                size = s;
                lines = attempt;
                break;
            }
        }
    }
    while (!ok(lines, size) && size - step >= slot.minSize) {
        size = round(size - step);
        lines = wrapWords(words, size, maxWidth, m);
    }
    let rendered = lines.map((l) => l.join(' '));
    // Confirm with exact measurements; the estimate can be a hair optimistic
    let widths = await Promise.all(rendered.map((l) => m.exact(l, size)));
    while (widths.some((w) => w > maxWidth + 0.5) && size - step >= slot.minSize) {
        size = round(size - step);
        lines = wrapWords(words, size, maxWidth, m);
        rendered = lines.map((l) => l.join(' '));
        widths = await Promise.all(rendered.map((l) => m.exact(l, size)));
    }
    if (rendered.length > slot.maxLines || widths.some((w) => w > maxWidth + 0.5)) {
        // Still too long at the smallest size: keep the first lines and end the last one with an ellipsis
        rendered = rendered.slice(0, slot.maxLines);
        let last = rendered[rendered.length - 1] || '';
        while (last.length > 1 && (await m.exact(`${last}…`, size)) > maxWidth)
            last = last.slice(0, -1).trimEnd();
        rendered = [...rendered.slice(0, -1), `${last}…`];
        widths = await Promise.all(rendered.map((l) => m.exact(l, size)));
    }
    const ratio = size / slot.fontSize;
    const lineHeight = slot.lineHeight * ratio;
    const shift = (slot.designLines * slot.lineHeight - rendered.length * lineHeight) / 2;
    const ascent = (slot.baseline - slot.top) * ratio;
    return { lines: rendered, widths, size, lineHeight, shift, firstBaseline: slot.top + shift + ascent };
}
// ---- layers ----
async function shapedPhoto(photo, shape, scale) {
    const w = Math.round(shape.w * scale);
    const h = Math.round(shape.h * scale);
    const mask = shape.shape === 'ellipse'
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#fff"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${shape.radius * scale}" fill="#fff"/></svg>`;
    const fitted = await (0, sharp_1.default)(photo, { failOn: 'none', limitInputPixels: 40_000_000 })
        .rotate()
        .resize(w, h, { fit: 'cover', position: sharp_1.default.strategy.attention })
        .ensureAlpha()
        .png()
        .toBuffer();
    return (0, sharp_1.default)(fitted).composite([{ input: Buffer.from(mask), blend: 'dest-in' }]).png().toBuffer();
}
async function containedImage(image, box, scale) {
    return (0, sharp_1.default)(image, { failOn: 'none', limitInputPixels: 40_000_000 })
        .rotate()
        .resize(Math.round(box.w * scale), Math.round(box.h * scale), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha()
        .png()
        .toBuffer();
}
async function qrImage(qr, size, scale) {
    const px = Math.round(size * scale);
    let source = qr;
    try {
        // The QR library adds its own white margin; the artwork already provides a white box, so use the full area for the code
        source = await (0, sharp_1.default)(qr).trim({ threshold: 10 }).png().toBuffer();
    }
    catch {
        source = qr;
    }
    return (0, sharp_1.default)(source).resize(px, px, { fit: 'fill', kernel: 'nearest' }).png().toBuffer();
}
const silhouette = (cx, cy, r, ink) => `<g fill="${ink}" fill-opacity="0.35"><circle cx="${round(cx)}" cy="${round(cy - r * 0.18)}" r="${round(r * 0.28)}"/><path d="M${round(cx - r * 0.55)} ${round(cy + r * 0.62)} C${round(cx - r * 0.55)} ${round(cy + r * 0.2)} ${round(cx - r * 0.25)} ${round(cy + r * 0.12)} ${round(cx)} ${round(cy + r * 0.12)} C${round(cx + r * 0.25)} ${round(cy + r * 0.12)} ${round(cx + r * 0.55)} ${round(cy + r * 0.2)} ${round(cx + r * 0.55)} ${round(cy + r * 0.62)}Z"/></g>`;
/** Renders a card and returns it as PNG bytes. */
async function renderTemplateCard(input) {
    const layout = layouts_generated_1.CARD_LAYOUTS[input.design];
    if (!layout)
        throw new Error(`Unknown card design: ${input.design}`);
    const scale = input.scale && input.scale > 0 ? input.scale : exports.DEFAULT_SCALE;
    await (0, fonts_1.ensureCardFonts)();
    const width = Math.round(layout.width * scale);
    const height = Math.round(layout.height * scale);
    const layers = [];
    const svg = [];
    // photo (personal designs): the organizer's picture in the designers' frame, or a neutral placeholder
    if (layout.photo) {
        let placed = false;
        if (input.photo) {
            try {
                layers.push({ input: await shapedPhoto(input.photo, layout.photo, scale), left: Math.round(layout.photo.x * scale), top: Math.round(layout.photo.y * scale) });
                placed = true;
            }
            catch (err) {
                console.warn('[cards] Event photo could not be used:', err instanceof Error ? err.message : 'unknown error');
            }
        }
        if (!placed) {
            const p = layout.photo;
            const palette = PHOTO_FALLBACK[input.design] || { fill: '#EEE', ink: '#555' };
            const x = p.x * scale;
            const y = p.y * scale;
            const w = p.w * scale;
            const h = p.h * scale;
            svg.push(p.shape === 'ellipse'
                ? `<ellipse cx="${round(x + w / 2)}" cy="${round(y + h / 2)}" rx="${round(w / 2)}" ry="${round(h / 2)}" fill="${palette.fill}"/>`
                : `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${p.radius * scale}" fill="${palette.fill}"/>`);
            const initials = cleanText(input.initials || '').slice(0, 3);
            if (initials) {
                svg.push(`<text x="${round(x + w / 2)}" y="${round(y + h / 2 + h * 0.12)}" text-anchor="middle" font-family="${(0, fonts_1.fontStack)('Inter')}" font-weight="700" font-size="${round(h * 0.36)}" fill="${palette.ink}" fill-opacity="0.8">${escapeXml(initials)}</text>`);
            }
            else {
                svg.push(silhouette(x + w / 2, y + h / 2, Math.min(w, h) / 2, palette.ink));
            }
        }
    }
    // logo (corporate designs)
    if (layout.logo && input.logo) {
        try {
            layers.push({ input: await containedImage(input.logo, layout.logo, scale), left: Math.round(layout.logo.x * scale), top: Math.round(layout.logo.y * scale) });
        }
        catch (err) {
            console.warn('[cards] Event logo could not be used:', err instanceof Error ? err.message : 'unknown error');
        }
    }
    // QR code
    if (layout.qr && input.qr) {
        layers.push({ input: await qrImage(input.qr, layout.qr.size, scale), left: Math.round(layout.qr.x * scale), top: Math.round(layout.qr.y * scale) });
    }
    // text
    const pinReserve = layout.pin ? layout.pin.w + 10 : 0;
    for (const [name, slot] of Object.entries(layout.texts)) {
        const value = input.texts[name];
        if (!value || !cleanText(value))
            continue;
        const fitted = await fitText(layout, slot, value, name === 'address' ? pinReserve : 0);
        fitted.lines.forEach((line, i) => {
            svg.push(`<text x="${round(slot.cx * scale)}" y="${round((fitted.firstBaseline + i * fitted.lineHeight) * scale)}" text-anchor="middle" font-family="${(0, fonts_1.fontStack)(slot.fontFamily)}" font-weight="${slot.fontWeight}" font-size="${round(fitted.size * scale)}" fill="${slot.color}"${slot.letterSpacing ? ` letter-spacing="${round(slot.letterSpacing * scale)}"` : ''}>${escapeXml(line)}</text>`);
        });
        // the location pin travels with the address text: just left of its widest line, level with the first line
        if (name === 'address' && layout.pin) {
            const widest = Math.max(...fitted.widths);
            const pinX = slot.cx - widest / 2 - 7 - layout.pin.w;
            const pinY = slot.top + fitted.shift + layout.pin.offsetY;
            svg.push(`<path transform="translate(${round(pinX * scale)} ${round(pinY * scale)}) scale(${scale})" d="${layout.pin.d}" fill="${layout.pin.color}"/>`);
        }
    }
    if (svg.length) {
        layers.push({
            input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svg.join('')}</svg>`),
            left: 0,
            top: 0,
        });
    }
    const background = await loadBackground(layout, scale);
    return (0, sharp_1.default)(background).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}
/** The designers' sample text for each slot, used for template previews. */
function sampleTexts(design) {
    const layout = layouts_generated_1.CARD_LAYOUTS[design];
    return Object.fromEntries(Object.entries(layout.texts).map(([name, slot]) => [name, slot.sample]));
}
const cardLayout = (design) => layouts_generated_1.CARD_LAYOUTS[design];
exports.cardLayout = cardLayout;
