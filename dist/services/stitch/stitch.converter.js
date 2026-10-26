"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.convertStitchDesign = convertStitchDesign;
const cheerio = __importStar(require("cheerio"));
const sharp_1 = __importDefault(require("sharp"));
const qrcode_1 = __importDefault(require("qrcode"));
const designSpec_1 = require("../cardTemplates/designSpec");
const specRenderer_1 = require("../cardTemplates/specRenderer");
const sampleData_1 = require("./sampleData");
const MAX_HTML_FOR_PARSE = 1_500_000;
const hsl = (hex) => {
    const [r, g, b] = (0, designSpec_1.hexToRgb)(hex).map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return { h: 0, s, l };
};
const distance = (a, b) => {
    const [r1, g1, b1] = (0, designSpec_1.hexToRgb)(a);
    const [r2, g2, b2] = (0, designSpec_1.hexToRgb)(b);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
};
async function sampleScreenshot(png) {
    try {
        const { data, info } = await (0, sharp_1.default)(png, { failOn: 'none', limitInputPixels: 40_000_000 }).resize(64, 112, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const bucket = (r, g, b) => `${r >> 4},${g >> 4},${b >> 4}`;
        const edge = new Map();
        const all = new Map();
        const rowAvg = (y0, y1) => {
            let r = 0, g = 0, b = 0, n = 0;
            for (let y = y0; y < y1; y++)
                for (let x = 0; x < info.width; x++) {
                    const i = (y * info.width + x) * 3;
                    r += data[i];
                    g += data[i + 1];
                    b += data[i + 2];
                    n++;
                }
            return (0, designSpec_1.rgbToHex)(r / n, g / n, b / n);
        };
        for (let y = 0; y < info.height; y++)
            for (let x = 0; x < info.width; x++) {
                const i = (y * info.width + x) * 3;
                const k = bucket(data[i], data[i + 1], data[i + 2]);
                const add = (m) => {
                    const e = m.get(k) || { sum: [0, 0, 0], n: 0 };
                    e.sum[0] += data[i];
                    e.sum[1] += data[i + 1];
                    e.sum[2] += data[i + 2];
                    e.n++;
                    m.set(k, e);
                };
                add(all);
                if (x < 5 || x >= info.width - 5 || y < 6 || y >= info.height - 6)
                    add(edge);
            }
        const toSwatches = (m) => [...m.values()].map((e) => ({ color: (0, designSpec_1.rgbToHex)(e.sum[0] / e.n, e.sum[1] / e.n, e.sum[2] / e.n), weight: e.n })).sort((a, b) => b.weight - a.weight);
        return { edge: toSwatches(edge), all: toSwatches(all), top: rowAvg(0, 10), bottom: rowAvg(info.height - 10, info.height) };
    }
    catch {
        return null;
    }
}
/** Hex colours the concept's own CSS/markup uses, most frequent first (read as text; nothing is evaluated). */
function declaredColors(html) {
    const counts = new Map();
    for (const m of html.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-zA-Z])/g)) {
        const raw = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
        const hex = `#${raw.toLowerCase()}`;
        counts.set(hex, (counts.get(hex) || 0) + 1);
    }
    return [...counts.entries()].map(([color, weight]) => ({ color, weight })).sort((a, b) => b.weight - a.weight);
}
/** Tailwind colour names -> hex, read from the config's text without evaluating it. */
function tailwindColors(html) {
    const out = {};
    const re = /["']([a-z][a-z0-9-]{1,40})["']\s*:\s*["'](#[0-9a-fA-F]{6})["']/g;
    let m;
    while ((m = re.exec(html)))
        if (!(m[1] in out))
            out[m[1]] = m[2].toLowerCase();
    return out;
}
// ---------- typography ----------
const SERIF = /(playfair|cormorant|lora|merriweather|baskerville|garamond|didot|bodoni|cinzel|libre\s*bask|dm\s*serif|abril|crimson|spectral|prata|marcellus|georgia|times|serif)/i;
const SCRIPT = /(great\s*vibes|dancing|pacifico|allura|alex\s*brush|parisienne|sacramento|tangerine|birthstone|italianno|script)/i;
function googleFamilies(html) {
    const names = [];
    const re = /fonts\.googleapis\.com\/css2?\?([^"'>\s]+)/g;
    let m;
    while ((m = re.exec(html))) {
        for (const part of m[1].replace(/&amp;/g, '&').split('&')) {
            if (!part.startsWith('family='))
                continue;
            const name = decodeURIComponent(part.slice(7).split(':')[0]).replace(/\+/g, ' ').trim();
            if (name && !/symbols|icons/i.test(name) && !names.includes(name))
                names.push(name);
        }
    }
    return names;
}
function mapFont(name, role) {
    const n = (name || '').toLowerCase();
    if (n.includes('playfair'))
        return 'Playfair Display';
    if (n.includes('manrope'))
        return 'Manrope';
    if (n.includes('inter'))
        return 'Inter';
    if (SCRIPT.test(n))
        return role === 'heading' ? 'Alex Brush' : 'Inter';
    if (SERIF.test(n))
        return role === 'heading' ? 'Playfair Display' : 'Ancizar Serif';
    return role === 'heading' ? 'Inter' : 'Inter';
}
function pickFonts(html) {
    // families named by the page's Google Fonts links, then by font-family declarations (the only way an SVG names its fonts)
    const families = googleFamilies(html);
    for (const m of html.matchAll(/font-family\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^;}>]+))/gi)) {
        for (const raw of (m[1] ?? m[2] ?? m[3] ?? '').split(',')) {
            const name = raw.replace(/["'\\]/g, '').trim();
            if (name && !/^(sans-serif|serif|monospace|system-ui|inherit|initial|cursive|ui-\w+)$/i.test(name) && !families.includes(name) && families.length < 8)
                families.push(name);
        }
    }
    const fromConfig = {};
    const re = /["']((?:display|headline|title|heading|body|label)[a-z0-9-]*)["']\s*:\s*\[\s*["']([^"']+)["']/g;
    let m;
    // fontFamily entries come as ["Family"]; fontSize entries share the key names but start with a size, so skip those
    while ((m = re.exec(html)))
        if (!(m[1] in fromConfig) && !/^\d/.test(m[2]))
            fromConfig[m[1]] = m[2];
    const headingName = Object.entries(fromConfig).find(([k]) => /display|headline|heading/.test(k))?.[1] || families.find((f) => SERIF.test(f) || SCRIPT.test(f)) || families[0];
    const bodyName = Object.entries(fromConfig).find(([k]) => /body|label/.test(k))?.[1] || families.find((f) => !SERIF.test(f) && !SCRIPT.test(f)) || families[1] || families[0];
    return { heading: mapFont(headingName, 'heading'), body: mapFont(bodyName, 'body'), names: [headingName, bodyName].filter(Boolean) };
}
const lighten = (hex, by) => {
    const [r, g, b] = (0, designSpec_1.hexToRgb)(hex);
    return (0, designSpec_1.rgbToHex)(r + (255 - r) * by, g + (255 - g) * by, b + (255 - b) * by);
};
const darken = (hex, by) => {
    const [r, g, b] = (0, designSpec_1.hexToRgb)(hex);
    return (0, designSpec_1.rgbToHex)(r * (1 - by), g * (1 - by), b * (1 - by));
};
/** Moves `color` toward white or black until it reads against `against`. */
function ensureContrast(color, against, min) {
    if ((0, designSpec_1.contrastRatio)(color, against) >= min)
        return color;
    const towardLight = (0, designSpec_1.luminance)(against) < 0.4;
    let c = color;
    for (let i = 0; i < 12 && (0, designSpec_1.contrastRatio)(c, against) < min; i++)
        c = towardLight ? lighten(c, 0.15) : darken(c, 0.15);
    return (0, designSpec_1.contrastRatio)(c, against) >= min ? c : towardLight ? '#ffffff' : '#111111';
}
async function derivePalette(html, shot) {
    const notes = [];
    const tw = tailwindColors(html);
    const sampled = shot ? await sampleScreenshot(shot) : null;
    let background = sampled?.edge[0]?.color || tw['background'] || tw['surface'] || tw['surface-dim'];
    if (!background)
        return { palette: null, notes: ['The concept has no recognisable colours to build a template from'] };
    // accent: the most saturated colour that takes up real space and stands apart from the background
    const twAccent = tw['primary-container'] || tw['primary'] || tw['tertiary'] || tw['secondary'] || tw['accent'];
    // the concept's own named accent is exact; the screenshot is only a fallback, because downscaling muddies thin gold lines
    // then the saturated, readable colour the concept's own CSS uses most (gold lines and headings are declared, not guessed)
    const declared = declaredColors(html).find((c) => hsl(c.color).s > 0.4 && hsl(c.color).l > 0.35 && hsl(c.color).l < 0.8 && distance(c.color, background) > 120);
    let accent = twAccent && distance(twAccent, background) > 90 ? twAccent : declared?.color || sampled?.all.filter((s) => hsl(s.color).s > 0.35 && distance(s.color, background) > 90 && s.weight > 6).sort((a, b) => b.weight * hsl(b.color).s - a.weight * hsl(a.color).s)[0]?.color;
    if (!accent)
        accent = twAccent;
    if (!accent) {
        notes.push('No accent colour was found in the concept; a neutral accent derived from its text colour is used');
        accent = (0, designSpec_1.luminance)(background) < 0.4 ? '#d9d9d9' : '#333333';
    }
    const primary = tw['primary'] && distance(tw['primary'], background) > 60 ? tw['primary'] : accent;
    let text = tw['on-background'] || tw['on-surface'] || tw['text'] || ((0, designSpec_1.luminance)(background) < 0.4 ? '#f5f5f5' : '#1a1a1a');
    text = ensureContrast(text, background, 7);
    // the accent colours small labels, so it must be comfortably readable, not just visible
    const accentSafe = ensureContrast(accent, background, 4.5);
    let background2;
    if (sampled && distance(sampled.top, sampled.bottom) > 18)
        background2 = distance(sampled.top, background) < distance(sampled.bottom, background) ? sampled.bottom : sampled.top;
    return { palette: { background, background2, primary, accent: accentSafe, text, muted: ensureContrast((0, designSpec_1.luminance)(background) < 0.4 ? lighten(background, 0.55) : darken(background, 0.5), background, 4.5) }, notes };
}
function readCues(html, $) {
    const photoish = $('img')
        .toArray()
        .filter((el) => {
        const alt = ($(el).attr('alt') || '').toLowerCase();
        const cls = ($(el).attr('class') || '').toLowerCase();
        return !/qr|icon|logo|seal|avatar/.test(alt) && !/qr|icon|logo/.test(cls);
    }).length;
    return {
        hasPhoto: photoish > 0,
        ornaments: /ornament|flourish|corner|filigree|deco/i.test(html),
        frame: /border-double|border-2|border-4|ring-|outline|inset-\d|frame/i.test(html),
        gradient: /gradient/i.test(html),
        wideTracking: (html.match(/tracking-(widest|wider|\[0\.\d+em\])/g) || []).length >= 2 || /letterSpacing"?:\s*"0\.[12]\d*em/.test(html),
        smallCaps: (html.match(/\buppercase\b/g) || []).length >= 3
    };
}
const text = (el) => ({ type: 'text', align: 'center', valign: 'top', fontWeight: 400, lineHeight: 1.2, letterSpacing: 0, uppercase: false, maxLines: 2, opacity: 1, ...el });
const label = (name, box, st, size, color = st.p.accent, align = 'center') => text({ role: 'label', label: name, align, ...box, h: Math.max(box.h, size * 1.5), size, color, fontFamily: st.body, fontWeight: 700, uppercase: true, letterSpacing: st.cues.wideTracking ? size * 0.28 : size * 0.16, maxLines: 1, minSize: size * 0.7 });
function decorations(W, H, st) {
    const out = [];
    const m = Math.round(Math.min(W, H) * 0.045);
    {
        // a double frame is the base of every converted design; ornaments add to it
        out.push({ type: 'rect', x: m, y: m, w: W - 2 * m, h: H - 2 * m, radius: 0, stroke: st.p.accent, strokeWidth: Math.max(2, W * 0.0025), opacity: 0.9 });
        out.push({ type: 'rect', x: m * 1.5, y: m * 1.5, w: W - 3 * m, h: H - 3 * m, radius: 0, stroke: st.p.accent, strokeWidth: Math.max(1, W * 0.001), opacity: 0.45 });
    }
    if (st.cues.ornaments) {
        const len = W * 0.07;
        const o = m * 1.5;
        const corners = [[o, o, 1, 1], [W - o, o, -1, 1], [o, H - o, 1, -1], [W - o, H - o, -1, -1]];
        for (const [cx, cy, sx, sy] of corners) {
            out.push({ type: 'line', x1: cx, y1: cy, x2: cx + sx * len, y2: cy, stroke: st.p.accent, strokeWidth: Math.max(3, W * 0.004), dash: false, opacity: 1 });
            out.push({ type: 'line', x1: cx, y1: cy, x2: cx, y2: cy + sy * len, stroke: st.p.accent, strokeWidth: Math.max(3, W * 0.004), dash: false, opacity: 1 });
        }
    }
    return out;
}
const divider = (W, y, st) => [
    { type: 'line', x1: W * 0.3, y1: y, x2: W * 0.46, y2: y, stroke: st.p.accent, strokeWidth: Math.max(2, W * 0.002), dash: false, opacity: 0.9 },
    { type: 'ellipse', x: W / 2 - W * 0.008, y: y - W * 0.008, w: W * 0.016, h: W * 0.016, fill: st.p.accent, strokeWidth: 0, opacity: 1 },
    { type: 'line', x1: W * 0.54, y1: y, x2: W * 0.7, y2: y, stroke: st.p.accent, strokeWidth: Math.max(2, W * 0.002), dash: false, opacity: 0.9 }
];
/** One centred column, used for invitations and portrait posters. Blocks that do not fit are dropped, never squeezed. */
function columnLayout(kind, W, H, st) {
    const margin = H * 0.065;
    const colX = W * 0.1;
    const colW = W * 0.8;
    const sz = (frac) => Math.round(W * frac);
    const qr = Math.min(W * 0.4, H * (H / W < 1.2 ? 0.27 : 0.22)); // squarer canvases have less height, so the code takes a larger share of it
    const isInvite = kind === 'INVITATION';
    const blocks = [
        { key: 'eyebrow', h: 0.03, build: (y, h) => [label(isInvite ? 'YOU_ARE_INVITED' : 'JOIN_US', { x: colX, y, w: colW, h }, st, sz(0.028))] },
        ...(isInvite || st.cues.hasPhoto
            ? [{ key: 'logo', h: 0.07, optional: 2, build: (y, h) => [{ type: 'image', slot: 'logo', x: W / 2 - h / 2, y, w: h, h, shape: 'rect', radius: 0, fit: 'contain', placeholderFill: st.p.muted }] }]
            : []),
        { key: 'title', h: 0.13, build: (y, h) => [text({ role: 'title', x: colX, y, w: colW, h, size: sz(0.085), minSize: sz(0.04), fontFamily: st.heading, fontWeight: 700, lineHeight: 1.12, maxLines: 3, color: st.p.text, valign: 'middle', letterSpacing: st.heading === 'Alex Brush' ? 0 : sz(0.001) })] },
        { key: 'rule', h: 0.02, build: (y, h) => divider(W, y + h / 2, st) },
        { key: 'description', h: 0.07, optional: 4, build: (y, h) => [text({ role: 'description', x: colX, y, w: colW, h, size: sz(0.03), minSize: sz(0.022), fontFamily: st.body, lineHeight: 1.45, maxLines: 3, color: st.p.muted })] },
        {
            key: 'when',
            h: 0.08,
            build: (y, h) => [
                label('DATE_LABEL', { x: colX, y, w: colW, h: h * 0.3 }, st, sz(0.024)),
                text({ role: 'dateTime', x: colX, y: y + h * 0.32, w: colW, h: h * 0.68, size: sz(0.04), minSize: sz(0.026), fontFamily: st.heading === 'Alex Brush' ? st.body : st.heading, fontWeight: 600, maxLines: 2, color: st.p.text })
            ]
        },
        {
            key: 'venue',
            h: 0.08,
            build: (y, h) => [
                label('VENUE_LABEL', { x: colX, y, w: colW, h: h * 0.3 }, st, sz(0.024)),
                text({ role: 'venue', x: colX, y: y + h * 0.32, w: colW, h: h * 0.68, size: sz(0.034), minSize: sz(0.022), fontFamily: st.body, fontWeight: 500, maxLines: 2, color: st.p.text })
            ]
        },
        ...(isInvite
            ? [
                {
                    key: 'guest',
                    h: 0.12,
                    optional: 1,
                    build: (y, h) => [
                        label('PERSONAL_INVITATION', { x: colX, y, w: colW, h: h * 0.2 }, st, sz(0.022), st.p.muted),
                        text({ role: 'inviteeName', x: colX, y: y + h * 0.22, w: colW, h: h * 0.5, size: sz(0.06), minSize: sz(0.03), fontFamily: st.heading, fontWeight: 600, maxLines: 2, color: st.p.primary, valign: 'middle' }),
                        text({ role: 'inviteeMeta', x: colX, y: y + h * 0.74, w: colW, h: h * 0.26, size: sz(0.026), minSize: sz(0.02), fontFamily: st.body, fontWeight: 500, maxLines: 1, color: st.p.muted })
                    ]
                }
            ]
            : []),
        {
            key: 'qr',
            h: qr / H + 0.04,
            build: (y) => [
                { type: 'qr', purpose: isInvite ? 'INVITATION' : 'REGISTRATION', x: W / 2 - qr / 2, y, size: qr, padding: 0.08, radius: qr * 0.04, frameColor: '#FFFFFF' },
                label(isInvite ? 'SCAN_TO_ENTER' : 'SCAN_TO_REGISTER', { x: colX, y: y + qr + H * 0.012, w: colW, h: H * 0.025 }, st, sz(0.022))
            ]
        },
        { key: 'host', h: 0.045, optional: 3, build: (y, h) => [label('HOSTED_BY', { x: colX, y, w: colW, h: h * 0.4 }, st, sz(0.018), st.p.muted), text({ role: 'organizer', x: colX, y: y + h * 0.42, w: colW, h: h * 0.58, size: sz(0.028), minSize: sz(0.02), fontFamily: st.body, fontWeight: 700, maxLines: 1, color: st.p.text })] }
    ];
    // drop the least important optional blocks until the column fits
    const gapOf = (n) => 0.012 * (n - 1);
    const avail = 1 - (2 * margin) / H;
    let used = blocks.slice();
    const total = (bs) => bs.reduce((s, b) => s + b.h, 0) + gapOf(bs.length);
    while (total(used) > avail) {
        const drop = used.filter((b) => b.optional).sort((a, b) => b.optional - a.optional)[0];
        if (!drop)
            break;
        used = used.filter((b) => b !== drop);
    }
    const elements = [];
    const slack = Math.max(0, avail - total(used));
    const gap = (0.012 + slack / Math.max(1, used.length - 1) / 1.5) * H;
    let y = margin + (slack > 0 ? (slack * H) / 6 : 0);
    for (const b of used) {
        const h = b.h * H;
        elements.push(...b.build(y, h));
        y += h + Math.min(gap, H * 0.03);
    }
    return { elements, archetype: isInvite ? 'column-invitation' : 'column-poster' };
}
/** Landscape poster: text on the left, QR (and the event photo, when the concept has one) on the right. */
function landscapeLayout(W, H, st) {
    const pad = W * 0.07;
    const leftW = W * 0.54;
    const qr = Math.min(H * 0.42, W * 0.22);
    const rx = W - pad - Math.max(qr, W * 0.26);
    const els = [
        label('JOIN_US', { x: pad, y: H * 0.1, w: leftW, h: H * 0.05 }, st, H * 0.032, st.p.accent, 'left'),
        text({ role: 'title', align: 'left', x: pad, y: H * 0.17, w: leftW, h: H * 0.3, size: H * 0.13, minSize: H * 0.06, fontFamily: st.heading, fontWeight: 700, lineHeight: 1.08, maxLines: 3, color: st.p.text, valign: 'middle' }),
        { type: 'line', x1: pad, y1: H * 0.5, x2: pad + W * 0.12, y2: H * 0.5, stroke: st.p.accent, strokeWidth: Math.max(2, H * 0.004), dash: false, opacity: 1 },
        text({ role: 'description', align: 'left', x: pad, y: H * 0.54, w: leftW, h: H * 0.14, size: H * 0.036, minSize: H * 0.026, fontFamily: st.body, lineHeight: 1.4, maxLines: 3, color: st.p.muted }),
        text({ role: 'dateTime', align: 'left', x: pad, y: H * 0.72, w: leftW, h: H * 0.09, size: H * 0.045, minSize: H * 0.03, fontFamily: st.heading === 'Alex Brush' ? st.body : st.heading, fontWeight: 600, maxLines: 2, color: st.p.text }),
        text({ role: 'venue', align: 'left', x: pad, y: H * 0.83, w: leftW, h: H * 0.09, size: H * 0.038, minSize: H * 0.026, fontFamily: st.body, fontWeight: 500, maxLines: 2, color: st.p.text }),
        { type: 'qr', purpose: 'REGISTRATION', x: rx + (Math.max(qr, W * 0.26) - qr) / 2, y: H * 0.24, size: qr, padding: 0.08, radius: qr * 0.04, frameColor: '#FFFFFF' },
        label('SCAN_TO_REGISTER', { x: rx, y: H * 0.24 + qr + H * 0.03, w: Math.max(qr, W * 0.26), h: H * 0.05 }, st, H * 0.028),
        text({ role: 'organizer', x: rx, y: H * 0.82, w: Math.max(qr, W * 0.26), h: H * 0.08, size: H * 0.035, minSize: H * 0.024, fontFamily: st.body, fontWeight: 700, maxLines: 2, color: st.p.text })
    ];
    return { elements: els, archetype: 'landscape-poster' };
}
// ---------- gate ----------
const MIN_QR_MODULE_PX = 4;
async function qualityGate(spec) {
    const problems = [];
    const bg = spec.palette.background;
    for (const el of spec.elements) {
        if (el.type === 'text' && (0, designSpec_1.contrastRatio)(el.color, bg) < 3)
            problems.push(`The ${el.role} text would be hard to read against the background`);
        if (el.type === 'qr') {
            const modules = qrcode_1.default.create(`${'https://lgpsm-frontend.vercel.app/invitation/'}${'a'.repeat(64)}`, { errorCorrectionLevel: 'H' }).modules.size;
            const px = el.size / (1 + 2 * el.padding);
            if (px / modules < MIN_QR_MODULE_PX)
                problems.push('The QR code is too small to scan reliably');
        }
    }
    try {
        const qr = await qrcode_1.default.toBuffer('https://example.org/invitation/sample', { errorCorrectionLevel: 'H', margin: 4, width: 480 });
        const out = await (0, specRenderer_1.renderDesignSpec)({ spec, texts: sampleData_1.SAMPLE_TEXTS[spec.kind], qr, scale: 0.4 });
        if (out.warnings.some((w) => /shortened/.test(w)))
            problems.push('Typical event text does not fit the layout');
    }
    catch {
        problems.push('The design could not be drawn');
    }
    return problems;
}
// ---------- entry point ----------
async function convertStitchDesign(input) {
    const notes = [];
    const preset = designSpec_1.CANVAS_PRESETS[input.preset];
    if (!preset || preset.kind !== input.kind)
        return { ready: false, fidelity: 'NONE', notes: ['That canvas size does not suit this kind of template'] };
    if (!input.html || input.html.length > MAX_HTML_FOR_PARSE)
        return { ready: false, fidelity: 'NONE', notes: ['The generated design was empty or too large to convert'] };
    let $;
    try {
        $ = cheerio.load(input.html, { scriptingEnabled: false });
    }
    catch {
        return { ready: false, fidelity: 'NONE', notes: ['The generated HTML could not be read'] };
    }
    // The scripts and styles are only ever *read as text* below (colour and font names); nothing is run or kept.
    const cues = readCues(input.html, $);
    const { palette, notes: paletteNotes } = await derivePalette(input.html, input.screenshot);
    notes.push(...paletteNotes);
    if (!palette)
        return { ready: false, fidelity: 'NONE', notes };
    const fonts = pickFonts(input.html);
    const st = { p: palette, heading: fonts.heading, body: fonts.body, cues };
    if (fonts.names.some((n) => !['inter', 'manrope', 'playfair display'].includes(n.toLowerCase())))
        notes.push('A font used in the concept is not bundled; the closest bundled font is used');
    const { width: W, height: H } = preset;
    const layout = input.kind === 'POSTER' && W > H ? landscapeLayout(W, H, st) : columnLayout(input.kind, W, H, st);
    const background = palette.background2 && cues.gradient ? { type: 'linear', angle: 180, stops: [palette.background, palette.background2] } : palette.background;
    const candidate = {
        version: designSpec_1.SPEC_VERSION,
        kind: input.kind,
        canvas: { preset: input.preset, width: W, height: H },
        background,
        palette: { background: palette.background, primary: palette.primary, accent: palette.accent, text: palette.text },
        elements: [...decorations(W, H, st), ...layout.elements],
        meta: { generator: 'STITCH', archetype: layout.archetype, styleNotes: [`heading ${fonts.heading}`, `body ${fonts.body}`, cues.ornaments ? 'corner ornaments' : 'plain frame'] }
    };
    const parsed = (0, designSpec_1.safeParseDesignSpec)(candidate);
    if (!parsed.ok)
        return { ready: false, fidelity: 'NONE', notes: [...notes, 'The converted design did not pass validation'] };
    const problems = await qualityGate(parsed.spec);
    if (problems.length)
        return { ready: false, fidelity: 'NONE', notes: [...notes, ...problems] };
    notes.push('The layout was rebuilt in the LGPSM format: colours, fonts and decoration follow the concept, event details are filled in automatically');
    return {
        ready: true,
        spec: parsed.spec,
        fidelity: 'STYLE_ADAPTED',
        notes,
        style: { background: palette.background, accent: palette.accent, text: palette.text, headingFont: fonts.heading, bodyFont: fonts.body, archetype: layout.archetype }
    };
}
