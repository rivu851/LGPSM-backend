"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MASTER_SAMPLE = exports.MASTER_HEIGHT = exports.MASTER_WIDTH = void 0;
exports.renderMasterCard = renderMasterCard;
const fs_1 = __importDefault(require("fs"));
const sharp_1 = __importDefault(require("sharp"));
const assetPath_1 = require("../../utils/assetPath");
const fonts_1 = require("./fonts");
/**
 * The master invitation card (Figma "Master Card"): one fixed watercolour background and a column of details that is laid out
 * from what the card actually has to say. Nothing is positioned by slot: when a detail is switched off (logo, QR code, additional
 * information) the rest closes up and the whole column stays centred on the card, exactly like the designers' variants.
 *
 *   logo · title · primary info · secondary info · QR code + "Scan QR Code" · date & time · rule · location
 *
 * All sizes are in Figma pixels on the 393 x 682 card and scaled at the end.
 */
exports.MASTER_WIDTH = 393;
exports.MASTER_HEIGHT = 682;
const INK = '#004387';
const ORANGE = '#EF851A';
const CONTENT_WIDTH = 345;
const LINE_HEIGHT = 1.2102; // Inter's "normal" line height
const ASCENT = 0.96875; // Inter's ascent, in em: where the baseline sits in a line box
const LOGO = 90;
const QR_BOX = 160;
const BORDER = 1.746;
const SCALE_DEFAULT = 2;
const TOP_MIN = 20;
const round = (n) => Math.round(n * 100) / 100;
const escapeXml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// eslint-disable-next-line no-control-regex
const clean = (t) => (t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
/** Wraps `text` to the content width in at most `maxLines` lines, shrinking from `size` to `minSize` first; ends in "…" only as a last resort. */
async function fit(text, family, weight, size, minSize, maxLines) {
    const words = text.split(' ').filter(Boolean);
    const widthAt = (t, s) => (0, fonts_1.measureText)(t, family, weight, s);
    const wrapAt = async (s) => {
        const lines = [];
        let current = '';
        for (const w of words) {
            const next = current ? `${current} ${w}` : w;
            if (!current || (await widthAt(next, s)) <= CONTENT_WIDTH)
                current = next;
            else {
                lines.push(current);
                current = w;
            }
        }
        if (current)
            lines.push(current);
        return lines;
    };
    const fits = async (lines, s) => lines.length <= maxLines && (await Promise.all(lines.map((l) => widthAt(l, s)))).every((w) => w <= CONTENT_WIDTH + 0.5);
    let s = size;
    let lines = await wrapAt(s);
    while (!(await fits(lines, s)) && s - 0.5 >= minSize) {
        s = round(s - 0.5);
        lines = await wrapAt(s);
    }
    if (!(await fits(lines, s))) {
        // last resort: keep the first lines and shorten the final one with an ellipsis
        lines = lines.slice(0, maxLines);
        let last = lines[lines.length - 1] || '';
        while (last.length > 1 && (await widthAt(`${last}…`, s)) > CONTENT_WIDTH)
            last = last.slice(0, -1).trimEnd();
        lines[lines.length - 1] = `${last}…`;
    }
    return { lines, size: s };
}
const heightOf = (w) => w.lines.length * w.size * LINE_HEIGHT;
const textSvg = (w, top, weight, color, s) => w.lines.map((line, i) => `<text x="${round((exports.MASTER_WIDTH / 2) * s)}" y="${round((top + i * w.size * LINE_HEIGHT + w.size * ASCENT) * s)}" text-anchor="middle" font-family="${(0, fonts_1.fontStack)('Inter')}" font-weight="${weight}" font-size="${round(w.size * s)}" fill="${color}">${escapeXml(line)}</text>`).join('');
let backgroundCache = null;
const background = () => (backgroundCache ??= fs_1.default.readFileSync((0, assetPath_1.assetPath)('cardTemplates', 'master', 'background.png')));
let sampleLogoCache = null;
const sampleLogo = () => (sampleLogoCache ??= fs_1.default.readFileSync((0, assetPath_1.assetPath)('cardTemplates', 'master', 'sample-logo.png')));
/** The designers' own wording, for the template's preview */
exports.MASTER_SAMPLE = {
    title: 'Annual Business Leadership and Innovation Summit 26',
    primary: 'PWT',
    secondary: '#PWT-05',
    dateTime: 'Thu 31 Dec 2026 2:00 PM – Fri 1 Jan 2027 4:00 PM',
    location: 'Grand Ballroom, 25 Park Street, Kolkata, WB, India',
    scanLabel: 'Scan QR Code',
};
async function renderMasterCard(input) {
    await (0, fonts_1.ensureCardFonts)();
    const s = input.scale && input.scale > 0 ? input.scale : SCALE_DEFAULT;
    const width = Math.round(exports.MASTER_WIDTH * s);
    const height = Math.round(exports.MASTER_HEIGHT * s);
    const title = clean(input.title);
    const primary = clean(input.primary);
    const secondary = clean(input.secondary);
    const when = clean(input.dateTime);
    const where = clean(input.location);
    const logo = input.logo || (input.useSampleLogo ? sampleLogo() : null);
    const qr = input.qr || null;
    const blocks = [];
    const gaps = []; // the gap before each block (the first has none)
    const add = (block, gap) => { gaps.push(blocks.length ? gap : 0); blocks.push(block); };
    if (logo) {
        const png = await (0, sharp_1.default)(logo, { failOn: 'none' }).rotate().resize(Math.round(LOGO * s), Math.round(LOGO * s), { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
        add({ height: LOGO, draw: (top, _svg, layers) => { layers.push({ input: png, left: Math.round(((exports.MASTER_WIDTH - LOGO) / 2) * s), top: Math.round(top * s) }); } }, 0);
    }
    if (title) {
        const t = await fit(title, 'Inter', 700, 26, 16, 4);
        add({ height: heightOf(t), draw: (top, svg) => { svg.push(textSvg(t, top, 700, INK, s)); } }, 14);
    }
    if (primary || secondary) {
        const a = primary ? await fit(primary, 'Inter', 700, 22, 12, 1) : null;
        const b = secondary ? await fit(secondary, 'Inter', 500, 14, 10, 1) : null;
        add({
            height: (a ? heightOf(a) : 0) + (a && b ? 8 : 0) + (b ? heightOf(b) : 0),
            draw: (top, svg) => {
                let y = top;
                if (a) {
                    svg.push(textSvg(a, y, 700, ORANGE, s));
                    y += heightOf(a) + 8;
                }
                if (b)
                    svg.push(textSvg(b, y, 500, INK, s));
            },
        }, 19);
    }
    const qrBlock = async (box) => {
        const inner = Math.round((box - 16) * s);
        const png = await (0, sharp_1.default)(qr, { failOn: 'none' }).resize(inner, inner, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
        const scan = await fit(clean(input.scanLabel) || 'Scan QR Code', 'Inter', 500, 14, 10, 1);
        return {
            height: box + 8 + heightOf(scan),
            draw: (top, svg, layers) => {
                const x = (exports.MASTER_WIDTH - box) / 2;
                svg.push(`<rect x="${round((x + BORDER / 2) * s)}" y="${round((top + BORDER / 2) * s)}" width="${round((box - BORDER) * s)}" height="${round((box - BORDER) * s)}" fill="#ffffff" stroke="${INK}" stroke-width="${round(BORDER * s)}"/>`);
                layers.push({ input: png, left: Math.round((x + 8) * s), top: Math.round((top + 8) * s) });
                svg.push(textSvg(scan, top + box + 8, 500, INK, s));
            },
        };
    };
    let qrIndex = -1;
    if (qr) {
        qrIndex = blocks.length;
        add(await qrBlock(QR_BOX), 38);
    }
    if (when || where) {
        const d = when ? await fit(when, 'Inter', 700, 18, 12, 2) : null;
        const l = where ? await fit(where, 'Inter', 400, 18, 12, 3) : null;
        add({
            height: (d ? heightOf(d) : 0) + (d && l ? 21 : 0) + (l ? heightOf(l) : 0),
            draw: (top, svg) => {
                let y = top;
                if (d) {
                    svg.push(textSvg(d, y, 700, INK, s));
                    y += heightOf(d) + 10;
                }
                if (d && l) {
                    const x1 = round(((exports.MASTER_WIDTH - CONTENT_WIDTH) / 2) * s);
                    const x2 = round(((exports.MASTER_WIDTH + CONTENT_WIDTH) / 2) * s);
                    svg.push(`<line x1="${x1}" y1="${round((y + 0.5) * s)}" x2="${x2}" y2="${round((y + 0.5) * s)}" stroke="${INK}" stroke-opacity="0.5" stroke-width="${round(s)}"/>`);
                    y += 11;
                }
                if (l)
                    svg.push(textSvg(l, y, 400, INK, s));
            },
        }, qr ? 20 : 24);
    }
    // the column is centred on the card; when it is too tall the QR box shrinks, then the gaps
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    const total = () => sum(blocks.map((b) => b.height)) + sum(gaps);
    const room = exports.MASTER_HEIGHT - 2 * TOP_MIN;
    if (qr && total() > room) {
        for (let box = QR_BOX - 10; box >= 110 && total() > room; box -= 10)
            blocks[qrIndex] = await qrBlock(box);
    }
    const squeeze = total() > room ? Math.max(0.3, (room - sum(blocks.map((b) => b.height))) / Math.max(1, sum(gaps))) : 1;
    const used = sum(blocks.map((b) => b.height)) + sum(gaps) * squeeze;
    let y = Math.max(TOP_MIN, (exports.MASTER_HEIGHT - used) / 2);
    const svg = [];
    const layers = [];
    blocks.forEach((block, i) => {
        y += gaps[i] * squeeze;
        block.draw(y, svg, layers);
        y += block.height;
    });
    const base = await (0, sharp_1.default)(background()).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
    // text and the QR box first, then the pictures on top (the QR code sits inside its box)
    const composites = [];
    if (svg.length)
        composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svg.join('')}</svg>`), left: 0, top: 0 });
    composites.push(...layers);
    return (0, sharp_1.default)(base).composite(composites).png({ compressionLevel: 6 }).toBuffer();
}
