"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.paintOutAreas = paintOutAreas;
exports.adjustForEmptyGuestLines = adjustForEmptyGuestLines;
exports.outputSize = outputSize;
exports.renderDesignSpec = renderDesignSpec;
const sharp_1 = __importDefault(require("sharp"));
const resolveImageBase64_1 = require("../../utils/resolveImageBase64");
const designSpec_1 = require("./designSpec");
const fonts_1 = require("./fonts");
// Draws a DesignSpec (see designSpec.ts) with the event's real content, using the same engine and bundled fonts as
// the Figma-based cards: sharp composites images and one SVG of shapes and text per run of vector elements. Only
// validated spec values reach the SVG and every piece of text is escaped, so nothing a generator or an organizer
// supplies can become markup, script, a font download or a network request.
// zlib level 6: about 4x faster to encode than 9 for a card that is only ~40 KB larger (measured: 66 ms -> 18 ms)
const PNG_LEVEL = 6;
const MAX_TEXT_LENGTH = 400;
const MAX_OUTPUT_EDGE = 4096;
const FIT_STEP = 0.04;
const escapeXml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// eslint-disable-next-line no-control-regex
const cleanText = (t) => t.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);
const r2 = (n) => Math.round(n * 100) / 100;
async function fitBlock(el, raw) {
    let text = cleanText(raw);
    if (el.uppercase)
        text = text.toLocaleUpperCase();
    const words = text.split(' ').filter(Boolean);
    const minSize = el.minSize ?? Math.max(8, el.size * 0.55);
    const ref = 100;
    const widths = new Map();
    for (const w of new Set(words))
        widths.set(w, await (0, fonts_1.measureText)(w, el.fontFamily, el.fontWeight, ref));
    const space = Math.max(1, (await (0, fonts_1.measureText)('n n', el.fontFamily, el.fontWeight, ref)) - (await (0, fonts_1.measureText)('nn', el.fontFamily, el.fontWeight, ref)));
    const lineWidth = (ws, size) => ((ws.reduce((s, w) => s + (widths.get(w) || 0), 0) + Math.max(0, ws.length - 1) * space) * size) / ref + el.letterSpacing * ws.join(' ').length;
    const wrap = (size) => {
        const lines = [];
        let cur = [];
        for (const w of words) {
            if (cur.length === 0 || lineWidth([...cur, w], size) <= el.w)
                cur.push(w);
            else {
                lines.push(cur);
                cur = [w];
            }
        }
        if (cur.length)
            lines.push(cur);
        return lines;
    };
    const fits = (lines, size) => lines.length <= el.maxLines && lines.length * size * el.lineHeight <= el.h + 0.5 && lines.every((l) => lineWidth(l, size) <= el.w + 0.5);
    let size = el.size;
    let lines = wrap(size);
    while (!fits(lines, size) && size - el.size * FIT_STEP >= minSize) {
        size = r2(size - el.size * FIT_STEP);
        lines = wrap(size);
    }
    let rendered = lines.map((l) => l.join(' '));
    // confirm with exact measurements: the per-word estimate can be a hair optimistic
    const exact = (l, s) => (0, fonts_1.measureText)(l, el.fontFamily, el.fontWeight, s).then((w) => w + el.letterSpacing * l.length);
    while (rendered.length && (await Promise.all(rendered.map((l) => exact(l, size)))).some((w) => w > el.w + 0.5) && size - el.size * FIT_STEP >= minSize) {
        size = r2(size - el.size * FIT_STEP);
        rendered = wrap(size).map((l) => l.join(' '));
    }
    let truncated = false;
    const maxByHeight = Math.max(1, Math.floor((el.h + 0.5) / (size * el.lineHeight)));
    const allowed = Math.min(el.maxLines, maxByHeight);
    if (rendered.length > allowed) {
        rendered = rendered.slice(0, allowed);
        truncated = true;
    }
    if (rendered.length) {
        let last = rendered[rendered.length - 1];
        const overflow = async (l) => (await exact(l, size)) > el.w + 0.5;
        if (truncated || (await overflow(last))) {
            if (truncated)
                last = `${last}…`;
            while (last.length > 1 && (await overflow(last)))
                last = `${last.replace(/…$/, '').slice(0, -1).trimEnd()}…`;
            rendered[rendered.length - 1] = last;
            truncated = true;
        }
    }
    return { lines: rendered, size, truncated };
}
// ---- vector layers ----
class SvgChunk {
    s;
    defs = [];
    body = [];
    gradients = 0;
    constructor(s) {
        this.s = s;
    }
    get empty() {
        return this.body.length === 0;
    }
    fill(fill, box) {
        if (typeof fill === 'string')
            return `fill="${fill}"`;
        if (fill && typeof fill === 'object' && fill.type === 'linear') {
            const f = fill;
            const id = `g${this.gradients++}`;
            const rad = ((f.angle - 90) * Math.PI) / 180;
            const cx = box.x + box.w / 2;
            const cy = box.y + box.h / 2;
            const dx = (Math.cos(rad) * box.w) / 2;
            const dy = (Math.sin(rad) * box.h) / 2;
            this.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${r2((cx - dx) * this.s)}" y1="${r2((cy - dy) * this.s)}" x2="${r2((cx + dx) * this.s)}" y2="${r2((cy + dy) * this.s)}">${f.stops
                .map((c, i) => `<stop offset="${r2((i / (f.stops.length - 1)) * 100)}%" stop-color="${c}"/>`)
                .join('')}</linearGradient>`);
            return `fill="url(#${id})"`;
        }
        return 'fill="none"';
    }
    add(markup) {
        this.body.push(markup);
    }
    toSvg(width, height) {
        return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${this.defs.join('')}</defs>${this.body.join('')}</svg>`);
    }
}
const strokeAttrs = (el, s) => (el.stroke && (el.strokeWidth || 0) > 0 ? ` stroke="${el.stroke}" stroke-width="${r2(el.strokeWidth * s)}"` : '');
async function shapedImage(image, el, s) {
    const w = Math.max(1, Math.round(el.w * s));
    const h = Math.max(1, Math.round(el.h * s));
    const fitted = await (0, sharp_1.default)(image, { failOn: 'none', limitInputPixels: 40_000_000 })
        .rotate()
        .resize(w, h, el.fit === 'cover' ? { fit: 'cover', position: sharp_1.default.strategy.attention } : { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha()
        .png()
        .toBuffer();
    if (el.shape === 'rect' && el.radius <= 0)
        return fitted;
    const mask = el.shape === 'ellipse'
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#fff"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r2(el.radius * s)}" fill="#fff"/></svg>`;
    return (0, sharp_1.default)(fitted).composite([{ input: Buffer.from(mask), blend: 'dest-in' }]).png().toBuffer();
}
async function qrLayer(qr, size, padding, radius, frameColor, s) {
    const outer = Math.max(1, Math.round(size * s));
    const pad = Math.round(outer * (padding / (1 + 2 * padding)));
    const inner = Math.max(1, outer - 2 * pad);
    let source = qr;
    try {
        // the QR library adds its own margin: trim it so the quiet zone is exactly the design's padding
        source = await (0, sharp_1.default)(qr).trim({ threshold: 10 }).png().toBuffer();
    }
    catch {
        source = qr;
    }
    const code = await (0, sharp_1.default)(source).resize(inner, inner, { fit: 'fill', kernel: 'nearest' }).png().toBuffer();
    const frame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${outer}" height="${outer}"><rect width="${outer}" height="${outer}" rx="${r2(radius * s)}" fill="${frameColor}"/></svg>`);
    return (0, sharp_1.default)(frame).composite([{ input: code, left: pad, top: pad }]).png().toBuffer();
}
/**
 * Paints the old wording out of the organizer's picture. Each box is refilled from what surrounds it: every column is blended between the
 * rows just above and just below the box, every row between the columns just left and right, and the two are averaged, so flat colours and
 * soft gradients simply continue. The picture is untouched everywhere else.
 */
async function paintOutAreas(image, boxes) {
    if (boxes.length === 0)
        return image;
    const { data, info } = await (0, sharp_1.default)(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height;
    const px = (x, y) => (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4;
    const edge = 3; // rows / columns averaged on each side
    for (const b of boxes) {
        const x0 = Math.max(0, Math.floor(b.x)), y0 = Math.max(0, Math.floor(b.y));
        const x1 = Math.min(W, Math.ceil(b.x + b.w)), y1 = Math.min(H, Math.ceil(b.y + b.h));
        if (x1 - x0 < 1 || y1 - y0 < 1)
            continue;
        const avg = (cells) => [0, 1, 2].map((c) => cells.reduce((t, p) => t + data[px(p[0], p[1]) + c], 0) / cells.length);
        const top = [], bottom = [];
        for (let x = x0; x < x1; x++) {
            top[x] = avg(Array.from({ length: edge }, (_, i) => [x, y0 - 1 - i]));
            bottom[x] = avg(Array.from({ length: edge }, (_, i) => [x, y1 + i]));
        }
        const left = [], right = [];
        for (let y = y0; y < y1; y++) {
            left[y] = avg(Array.from({ length: edge }, (_, i) => [x0 - 1 - i, y]));
            right[y] = avg(Array.from({ length: edge }, (_, i) => [x1 + i, y]));
        }
        const out = Buffer.alloc((x1 - x0) * (y1 - y0) * 4);
        for (let y = y0; y < y1; y++) {
            const ty = (y - y0 + 0.5) / (y1 - y0);
            for (let x = x0; x < x1; x++) {
                const tx = (x - x0 + 0.5) / (x1 - x0);
                const o = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
                for (let c = 0; c < 3; c++) {
                    const vertical = top[x][c] * (1 - ty) + bottom[x][c] * ty;
                    const horizontal = left[y][c] * (1 - tx) + right[y][c] * tx;
                    out[o + c] = Math.round((vertical + horizontal) / 2);
                }
                out[o + 3] = 255;
            }
        }
        // a soft join: the refilled box is blurred a little, so no seam or streak shows where it meets the picture
        const soft = await (0, sharp_1.default)(out, { raw: { width: x1 - x0, height: y1 - y0, channels: 4 } }).blur(1.2).raw().toBuffer();
        for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++) {
                const o = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
                const t = px(x, y);
                data[t] = soft[o];
                data[t + 1] = soft[o + 1];
                data[t + 2] = soft[o + 2];
                data[t + 3] = 255;
            }
    }
    return (0, sharp_1.default)(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}
/** Is the picture bright where this box sits? (decides dark or light ink for what is printed there) */
async function isLightBehind(image, box, s) {
    if (!image)
        return true;
    try {
        const meta = await (0, sharp_1.default)(image).metadata();
        const w = meta.width || 0, h = meta.height || 0;
        const left = Math.max(0, Math.min(w - 1, Math.round(box.x * s)));
        const top = Math.max(0, Math.min(h - 1, Math.round(box.y * s)));
        const st = await (0, sharp_1.default)(image).extract({ left, top, width: Math.max(1, Math.min(w - left, Math.round(box.w * s))), height: Math.max(1, Math.min(h - top, Math.round(box.h * s))) }).flatten({ background: '#FFFFFF' }).stats();
        const [r, g, b] = st.channels;
        return 0.2126 * r.mean + 0.7152 * g.mean + 0.0722 * b.mean > 150;
    }
    catch {
        return true;
    }
}
/** The guest's QR code printed straight onto the picture: no white tile, only the code's own squares, dark on a light picture and white on a dark one. */
async function qrOnPicture(qr, size, light, s) {
    const px = Math.max(1, Math.round(size * s));
    let source = qr;
    try {
        source = await (0, sharp_1.default)(qr).trim({ threshold: 10 }).png().toBuffer();
    }
    catch {
        source = qr;
    }
    const { data, info } = await (0, sharp_1.default)(source).resize(px, px, { fit: 'fill', kernel: 'nearest' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const ink = light ? 0 : 255;
    const out = Buffer.alloc(info.width * info.height * 4);
    for (let i = 0; i < info.width * info.height; i++) {
        out[i * 4] = ink;
        out[i * 4 + 1] = ink;
        out[i * 4 + 2] = ink;
        out[i * 4 + 3] = 255 - data[i]; // the code's dark squares are opaque, its light squares and margin are see-through
    }
    return (0, sharp_1.default)(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}
/** Text for a text element: a fixed phrase for labels, otherwise the event's value for its role. */
function textFor(el, texts) {
    if (el.role === 'label')
        return el.label ? designSpec_1.STATIC_LABELS[el.label] : '';
    return texts[el.role] || '';
}
/**
 * A guest with no name or detail leaves the lines for them empty, and the space they would fill used to show as a gap. When
 * both guest lines are blank, the invitation QR is re-centred in the free space between the content above it (text or
 * images) and the content below it (text, images or a full-width band), so the card still looks balanced. Nothing else
 * moves, and a card whose guest lines have text is drawn exactly as designed.
 */
function adjustForEmptyGuestLines(spec, texts) {
    const elements = spec.elements;
    const blank = (role) => !cleanText(texts[role] || '');
    const hasSlots = elements.some((e) => e.type === 'text' && (e.role === 'inviteeName' || e.role === 'inviteeMeta'));
    const qr = elements.find((e) => e.type === 'qr' && e.purpose === 'INVITATION');
    if (!hasSlots || !qr || !blank('inviteeName') || !blank('inviteeMeta'))
        return elements;
    const visible = elements.filter((e) => (e.type === 'text' && !!cleanText(textFor(e, texts))) || e.type === 'image' || (e.type === 'rect' && e.w >= spec.canvas.width * 0.9));
    const top = (e) => (e.type === 'qr' ? e.y : e.type === 'line' ? Math.min(e.y1, e.y2) : e.y);
    const bottom = (e) => (e.type === 'qr' ? e.y + e.size : e.type === 'line' ? Math.max(e.y1, e.y2) : e.y + e.h);
    const above = visible.filter((e) => e.type !== 'rect' && bottom(e) <= qr.y + 1).map(bottom);
    const below = visible.filter((e) => top(e) >= qr.y + qr.size - 1).map(top);
    if (!above.length)
        return elements;
    const aboveBottom = Math.max(...above);
    const belowTop = below.length ? Math.min(...below) : spec.canvas.height;
    const free = belowTop - aboveBottom - qr.size;
    if (free <= 0)
        return elements;
    const y = Math.round(aboveBottom + free / 2);
    if (Math.abs(y - qr.y) < 1)
        return elements;
    return elements.map((e) => (e === qr ? { ...qr, y } : e));
}
function outputSize(spec, scale = 1) {
    const s = Math.min(scale > 0 ? scale : 1, MAX_OUTPUT_EDGE / Math.max(spec.canvas.width, spec.canvas.height));
    return { width: Math.round(spec.canvas.width * s), height: Math.round(spec.canvas.height * s), scale: s };
}
/** The organizer's own picture, cropped to the card, or null when the spec has none or it cannot be read */
async function loadBackgroundImage(spec, width, height, warnings) {
    if (!spec.backgroundMedia)
        return null;
    const data = await (0, resolveImageBase64_1.resolveImageKeyBase64)(spec.backgroundMedia);
    const comma = data.indexOf(',');
    if (comma <= 0) {
        warnings.push('The uploaded design could not be loaded');
        return null;
    }
    try {
        return await (0, sharp_1.default)(Buffer.from(data.slice(comma + 1), 'base64'), { failOn: 'none', limitInputPixels: 40_000_000 }).rotate().resize(width, height, { fit: 'cover', position: 'centre' }).png().toBuffer();
    }
    catch {
        warnings.push('The uploaded design could not be read');
        return null;
    }
}
/**
 * An uploaded design is the card as it is: the guest's QR code and name go straight onto the picture. There is no white panel behind
 * them (older uploads were saved with one: it is left out here), and the name takes dark or light type depending on how bright the picture
 * is where it sits. The QR keeps its thin white border: a code needs the quiet margin to scan.
 */
async function withoutUploadPanel(spec, image, s, bottomInset = 0) {
    if (spec.meta.generator !== 'UPLOAD')
        return spec;
    // Nothing is drawn over the organizer's picture except what is personal to each guest (the QR code and the name): the white panel older uploads
    // were saved with, any shade or gradient, and the event's own details typed over the picture are all left out.
    // (A design whose wording is replaced in place keeps its text elements: they sit on areas painted out of the picture.)
    const isOverlay = (e) => e.type === 'rect' || e.type === 'ellipse' || (!spec.meta.zones && e.type === 'text' && e.role !== 'inviteeName' && e.role !== 'inviteeMeta');
    const elements = await Promise.all(spec.elements.filter((e) => !isOverlay(e)).map(async (e) => {
        if (e.type !== 'text' || (e.role !== 'inviteeName' && e.role !== 'inviteeMeta') || !image)
            return e;
        try {
            const meta = await (0, sharp_1.default)(image).metadata();
            const w = meta.width || 0, h = meta.height || 0;
            const box = { left: Math.max(0, Math.min(w - 1, Math.round(e.x * s))), top: Math.max(0, Math.min(h - 1, Math.round(e.y * s))), width: 0, height: 0 };
            box.width = Math.max(1, Math.min(w - box.left, Math.round(e.w * s)));
            box.height = Math.max(1, Math.min(h - box.top, Math.round(e.h * s)));
            const st = await (0, sharp_1.default)(image).extract(box).stats();
            const [r, g, b] = st.channels;
            const light = 0.2126 * r.mean + 0.7152 * g.mean + 0.0722 * b.mean > 150;
            return { ...e, color: e.role === 'inviteeName' ? (light ? '#111111' : '#FFFFFF') : (light ? '#333333' : '#EDEDED') };
        }
        catch {
            return e;
        }
    }));
    // leave room at the bottom for the details block that is printed over the picture: the guest's QR code and name move up to clear it
    const bottomOf = (e) => (e.type === 'qr' ? e.y + e.size : 'y' in e && 'h' in e ? e.y + e.h : 0);
    const free = spec.canvas.height - bottomInset / s;
    const lowest = elements.reduce((m, e) => Math.max(m, bottomOf(e)), 0);
    const shift = bottomInset > 0 && lowest > free - 8 ? lowest - (free - 8) : 0;
    const moved = shift > 0 ? elements.map((e) => ('y' in e ? { ...e, y: Math.max(0, e.y - shift) } : e)) : elements;
    return { ...spec, elements: moved };
}
async function renderDesignSpec(input) {
    await (0, fonts_1.ensureCardFonts)();
    const { width, height, scale: s } = outputSize(input.spec, input.scale);
    const warnings = [];
    const backgroundImage = await loadBackgroundImage(input.spec, width, height, warnings);
    // the old wording of an uploaded design is painted out of the picture before anything is drawn on it
    const patches = input.spec.elements.filter((e) => e.type === 'patch').map((e) => ({ x: e.x * s, y: e.y * s, w: e.w * s, h: e.h * s }));
    const cleanedImage = backgroundImage && patches.length ? await paintOutAreas(backgroundImage, patches) : backgroundImage;
    const spec = await withoutUploadPanel(input.spec, cleanedImage, s, input.bottomInset ?? 0);
    const layers = [];
    let chunk = new SvgChunk(s);
    const flush = () => {
        if (!chunk.empty)
            layers.push({ input: chunk.toSvg(width, height), left: 0, top: 0 });
        chunk = new SvgChunk(s);
    };
    for (const el of adjustForEmptyGuestLines(spec, input.texts)) {
        switch (el.type) {
            case 'rect': {
                const box = { x: el.x, y: el.y, w: el.w, h: el.h };
                chunk.add(`<rect x="${r2(el.x * s)}" y="${r2(el.y * s)}" width="${r2(el.w * s)}" height="${r2(el.h * s)}" rx="${r2(el.radius * s)}" ${chunk.fill(el.fill, box)}${strokeAttrs(el, s)} opacity="${el.opacity}"/>`);
                break;
            }
            case 'ellipse': {
                const box = { x: el.x, y: el.y, w: el.w, h: el.h };
                chunk.add(`<ellipse cx="${r2((el.x + el.w / 2) * s)}" cy="${r2((el.y + el.h / 2) * s)}" rx="${r2((el.w / 2) * s)}" ry="${r2((el.h / 2) * s)}" ${chunk.fill(el.fill, box)}${strokeAttrs(el, s)} opacity="${el.opacity}"/>`);
                break;
            }
            case 'line':
                chunk.add(`<line x1="${r2(el.x1 * s)}" y1="${r2(el.y1 * s)}" x2="${r2(el.x2 * s)}" y2="${r2(el.y2 * s)}" stroke="${el.stroke}" stroke-width="${r2(el.strokeWidth * s)}" stroke-linecap="round"${el.dash ? ` stroke-dasharray="${r2(el.strokeWidth * 3 * s)} ${r2(el.strokeWidth * 3 * s)}"` : ''} opacity="${el.opacity}"/>`);
                break;
            case 'text': {
                const value = textFor(el, input.texts);
                if (!cleanText(value))
                    break;
                const fitted = await fitBlock(el, value);
                if (fitted.truncated)
                    warnings.push(`The ${el.role} text was shortened to fit its space`);
                const lh = fitted.size * el.lineHeight;
                const top = el.valign === 'middle' ? el.y + (el.h - fitted.lines.length * lh) / 2 : el.y;
                const anchor = el.align === 'left' ? 'start' : el.align === 'right' ? 'end' : 'middle';
                const ax = el.align === 'left' ? el.x : el.align === 'right' ? el.x + el.w : el.x + el.w / 2;
                fitted.lines.forEach((line, i) => {
                    chunk.add(`<text x="${r2(ax * s)}" y="${r2((top + i * lh + (lh - fitted.size) / 2 + fitted.size * 0.8) * s)}" text-anchor="${anchor}" font-family="${escapeXml((0, fonts_1.fontStack)(el.fontFamily))}" font-weight="${el.fontWeight}" font-size="${r2(fitted.size * s)}" fill="${el.color}" fill-opacity="${el.opacity}"${el.letterSpacing ? ` letter-spacing="${r2(el.letterSpacing * s)}"` : ''}>${escapeXml(line)}</text>`);
                });
                break;
            }
            case 'image': {
                const image = el.slot === 'logo' ? input.logo : input.photo;
                const left = Math.round(el.x * s);
                const top = Math.round(el.y * s);
                if (image) {
                    try {
                        flush();
                        layers.push({ input: await shapedImage(image, el, s), left, top });
                        break;
                    }
                    catch (err) {
                        warnings.push(`The ${el.slot} image could not be used`);
                        console.warn('[cards] Spec image could not be used:', err instanceof Error ? err.message : 'unknown error');
                    }
                }
                if (input.showPlaceholders && el.placeholderFill) {
                    chunk.add(el.shape === 'ellipse'
                        ? `<ellipse cx="${r2((el.x + el.w / 2) * s)}" cy="${r2((el.y + el.h / 2) * s)}" rx="${r2((el.w / 2) * s)}" ry="${r2((el.h / 2) * s)}" fill="${el.placeholderFill}"/>`
                        : `<rect x="${r2(el.x * s)}" y="${r2(el.y * s)}" width="${r2(el.w * s)}" height="${r2(el.h * s)}" rx="${r2(el.radius * s)}" fill="${el.placeholderFill}"/>`);
                }
                break;
            }
            case 'qr': {
                if (!input.qr) {
                    warnings.push(el.purpose === 'INVITATION' ? 'No invitation QR code was supplied' : 'No registration link was supplied, so the QR code was left out');
                    break;
                }
                flush();
                const onPicture = spec.meta.generator === 'UPLOAD' && !!cleanedImage;
                layers.push({
                    input: onPicture ? await qrOnPicture(input.qr, el.size, await isLightBehind(cleanedImage, { x: el.x, y: el.y, w: el.size, h: el.size }, s), s) : await qrLayer(input.qr, el.size, el.padding, el.radius, el.frameColor || '#FFFFFF', s),
                    left: Math.round(el.x * s),
                    top: Math.round(el.y * s)
                });
                break;
            }
        }
    }
    flush();
    const bg = new SvgChunk(s);
    const fill = bg.fill(spec.background, { x: 0, y: 0, w: spec.canvas.width, h: spec.canvas.height });
    bg.add(`<rect width="${width}" height="${height}" ${fill}/>`);
    // an uploaded design goes straight over the plain background, under everything else
    if (cleanedImage)
        layers.unshift({ input: cleanedImage, left: 0, top: 0 });
    const png = await (0, sharp_1.default)(bg.toSvg(width, height)).composite(layers).png({ compressionLevel: PNG_LEVEL }).toBuffer();
    return { png, width, height, warnings };
}
