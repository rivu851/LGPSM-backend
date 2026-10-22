"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.designSpecSchema = exports.elementSchema = exports.qrElementSchema = exports.imageElementSchema = exports.textElementSchema = exports.lineElementSchema = exports.ellipseElementSchema = exports.rectElementSchema = exports.TEXT_ROLES = exports.STATIC_LABEL_IDS = exports.STATIC_LABELS = exports.SPEC_FONTS = exports.MAX_ELEMENTS = exports.MAX_CANVAS = exports.MIN_CANVAS = exports.CANVAS_PRESET_IDS = exports.CANVAS_PRESETS = exports.SPEC_VERSION = void 0;
exports.parseDesignSpec = parseDesignSpec;
exports.safeParseDesignSpec = safeParseDesignSpec;
exports.normalizeDesignSpec = normalizeDesignSpec;
exports.hexToRgb = hexToRgb;
exports.rgbToHex = rgbToHex;
exports.luminance = luminance;
exports.contrastRatio = contrastRatio;
const zod_1 = require("zod");
// The LGPSM design specification: the only form in which an AI-generated (or hand-edited) design is stored and
// rendered. It is plain, closed data: positions, colours, bundled font names and *roles* that are filled with the
// event's real details at render time. It cannot hold markup, scripts, CSS, URLs, event details or a QR code, which
// is what makes a design safe to store and reuse for every event and every guest.
//
// Versioned so the renderer can keep reading old designs when the format grows: bump SPEC_VERSION and add a
// migration in `normalizeDesignSpec` rather than changing what version 1 means.
exports.SPEC_VERSION = 1;
exports.CANVAS_PRESETS = {
    INVITATION_PORTRAIT: { kind: 'INVITATION', width: 1080, height: 1920, label: 'Story / phone (9:16)' },
    INVITATION_CARD: { kind: 'INVITATION', width: 1080, height: 1350, label: 'Card (4:5)' },
    INVITATION_SQUARE: { kind: 'INVITATION', width: 1080, height: 1080, label: 'Square (1:1)' },
    POSTER_A4: { kind: 'POSTER', width: 1654, height: 2339, label: 'A4 poster (200 dpi)' },
    POSTER_PORTRAIT: { kind: 'POSTER', width: 1080, height: 1440, label: 'Portrait poster (3:4)' },
    POSTER_LANDSCAPE: { kind: 'POSTER', width: 1920, height: 1080, label: 'Landscape banner (16:9)' }
};
exports.CANVAS_PRESET_IDS = Object.keys(exports.CANVAS_PRESETS);
exports.MIN_CANVAS = 600;
exports.MAX_CANVAS = 3508;
exports.MAX_ELEMENTS = 60;
/** Families that ship with the app (src/assets/cardTemplates/fonts). Nothing is ever loaded from a CDN. */
exports.SPEC_FONTS = ['Inter', 'Manrope', 'Playfair Display', 'Ancizar Serif', 'Alexandria', 'Alkatra', 'Alex Brush', 'Birthstone'];
/** Fixed wording a design may carry. Event details are never part of a design: they are the text roles below. */
exports.STATIC_LABELS = {
    YOU_ARE_INVITED: 'You are invited',
    JOIN_US: 'Join us',
    SAVE_THE_DATE: 'Save the date',
    PERSONAL_INVITATION: 'Personal invitation for',
    ADMIT_ONE: 'Admit one',
    SCAN_TO_ENTER: 'Scan at the entrance',
    SCAN_TO_REGISTER: 'Scan to register',
    REGISTER_NOW: 'Register now',
    DATE_LABEL: 'Date',
    TIME_LABEL: 'Time',
    VENUE_LABEL: 'Venue',
    HOSTED_BY: 'Hosted by'
};
exports.STATIC_LABEL_IDS = Object.keys(exports.STATIC_LABELS);
exports.TEXT_ROLES = ['title', 'description', 'date', 'time', 'dateTime', 'venue', 'organizer', 'inviteeName', 'inviteeMeta', 'tagline', 'label'];
const hex = zod_1.z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colours must be #RRGGBB');
const px = (min, max) => zod_1.z.number().finite().min(min).max(max);
const coord = px(-200, exports.MAX_CANVAS + 200);
const length = px(0, exports.MAX_CANVAS + 200);
const opacity = zod_1.z.number().finite().min(0).max(1);
const base = { id: zod_1.z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).optional() };
const fillSchema = zod_1.z.union([
    hex,
    zod_1.z.object({ type: zod_1.z.literal('linear'), angle: px(0, 360), stops: zod_1.z.array(hex).min(2).max(4) }).strict()
]);
exports.rectElementSchema = zod_1.z
    .object({ ...base, type: zod_1.z.literal('rect'), x: coord, y: coord, w: length, h: length, radius: px(0, 2000).default(0), fill: fillSchema.optional(), stroke: hex.optional(), strokeWidth: px(0, 60).default(0), opacity: opacity.default(1) })
    .strict();
exports.ellipseElementSchema = zod_1.z
    .object({ ...base, type: zod_1.z.literal('ellipse'), x: coord, y: coord, w: length, h: length, fill: fillSchema.optional(), stroke: hex.optional(), strokeWidth: px(0, 60).default(0), opacity: opacity.default(1) })
    .strict();
exports.lineElementSchema = zod_1.z
    .object({ ...base, type: zod_1.z.literal('line'), x1: coord, y1: coord, x2: coord, y2: coord, stroke: hex, strokeWidth: px(0.5, 40).default(2), dash: zod_1.z.boolean().default(false), opacity: opacity.default(1) })
    .strict();
exports.textElementSchema = zod_1.z
    .object({
    ...base,
    type: zod_1.z.literal('text'),
    role: zod_1.z.enum(exports.TEXT_ROLES),
    /** Required (and only allowed) for role "label": one of the fixed phrases above */
    label: zod_1.z.enum(exports.STATIC_LABEL_IDS).optional(),
    x: coord,
    y: coord,
    w: px(20, exports.MAX_CANVAS),
    h: px(10, exports.MAX_CANVAS),
    align: zod_1.z.enum(['left', 'center', 'right']).default('center'),
    valign: zod_1.z.enum(['top', 'middle']).default('top'),
    fontFamily: zod_1.z.enum(exports.SPEC_FONTS),
    fontWeight: zod_1.z.union([zod_1.z.literal(400), zod_1.z.literal(500), zod_1.z.literal(600), zod_1.z.literal(700)]).default(400),
    size: px(10, 400),
    minSize: px(8, 400).optional(),
    lineHeight: px(0.9, 2.5).default(1.2),
    letterSpacing: px(-5, 40).default(0),
    uppercase: zod_1.z.boolean().default(false),
    maxLines: zod_1.z.number().int().min(1).max(8).default(2),
    color: hex,
    opacity: opacity.default(1)
})
    .strict()
    .superRefine((el, ctx) => {
    if (el.role === 'label' && !el.label)
        ctx.addIssue({ code: 'custom', message: 'A label needs one of the fixed phrases', path: ['label'] });
    if (el.role !== 'label' && el.label)
        ctx.addIssue({ code: 'custom', message: 'Only a label element carries a fixed phrase', path: ['label'] });
    if (el.minSize !== undefined && el.minSize > el.size)
        ctx.addIssue({ code: 'custom', message: 'minSize cannot exceed size', path: ['minSize'] });
});
exports.imageElementSchema = zod_1.z
    .object({
    ...base,
    type: zod_1.z.literal('image'),
    /** logo = the event's logo / organizer logo; photo = the event photo. Never a URL: the renderer supplies the image. */
    slot: zod_1.z.enum(['logo', 'photo']),
    x: coord,
    y: coord,
    w: px(20, exports.MAX_CANVAS),
    h: px(20, exports.MAX_CANVAS),
    shape: zod_1.z.enum(['rect', 'ellipse']).default('rect'),
    radius: px(0, 2000).default(0),
    fit: zod_1.z.enum(['cover', 'contain']).default('cover'),
    /** Painted when the event has no image for the slot (an empty frame is better than nothing in a design) */
    placeholderFill: hex.optional()
})
    .strict();
exports.qrElementSchema = zod_1.z
    .object({
    ...base,
    type: zod_1.z.literal('qr'),
    /** INVITATION: the guest's own check-in QR. REGISTRATION: the event's registration / event link (posters). */
    purpose: zod_1.z.enum(['INVITATION', 'REGISTRATION']),
    x: coord,
    y: coord,
    size: px(120, 1600),
    /** White quiet zone around the code, as a fraction of its size (QR readers need one) */
    padding: px(0.04, 0.2).default(0.08),
    radius: px(0, 200).default(0),
    frameColor: hex.optional()
})
    .strict();
exports.elementSchema = zod_1.z.discriminatedUnion('type', [exports.rectElementSchema, exports.ellipseElementSchema, exports.lineElementSchema, exports.textElementSchema, exports.imageElementSchema, exports.qrElementSchema]);
exports.designSpecSchema = zod_1.z
    .object({
    version: zod_1.z.literal(exports.SPEC_VERSION),
    kind: zod_1.z.enum(['INVITATION', 'POSTER']),
    canvas: zod_1.z
        .object({
        preset: zod_1.z.enum(exports.CANVAS_PRESET_IDS).optional(),
        width: zod_1.z.number().int().min(exports.MIN_CANVAS).max(exports.MAX_CANVAS),
        height: zod_1.z.number().int().min(exports.MIN_CANVAS).max(exports.MAX_CANVAS)
    })
        .strict()
        .refine((c) => c.width / c.height >= 0.4 && c.width / c.height <= 2.5, 'Unsupported aspect ratio'),
    background: fillSchema,
    palette: zod_1.z.object({ background: hex, primary: hex, accent: hex, text: hex }).strict(),
    elements: zod_1.z.array(exports.elementSchema).min(1).max(exports.MAX_ELEMENTS),
    /** Where the design came from; informational only, never used for rendering */
    meta: zod_1.z.object({ generator: zod_1.z.enum(['STITCH', 'MANUAL']).default('MANUAL'), archetype: zod_1.z.string().max(40).optional(), styleNotes: zod_1.z.array(zod_1.z.string().max(80)).max(8).optional() }).strict().default({ generator: 'MANUAL' })
})
    .strict()
    .superRefine((spec, ctx) => {
    const qrs = spec.elements.filter((e) => e.type === 'qr');
    if (qrs.length > 1)
        ctx.addIssue({ code: 'custom', message: 'A design has at most one QR code', path: ['elements'] });
    if (spec.kind === 'INVITATION' && qrs.some((q) => q.type === 'qr' && q.purpose === 'REGISTRATION'))
        ctx.addIssue({ code: 'custom', message: 'An invitation carries the guest QR code, not a registration link', path: ['elements'] });
    if (spec.kind === 'POSTER' && qrs.some((q) => q.type === 'qr' && q.purpose === 'INVITATION'))
        ctx.addIssue({ code: 'custom', message: 'A poster has no personal guest QR code', path: ['elements'] });
    if (spec.kind === 'INVITATION' && qrs.length === 0)
        ctx.addIssue({ code: 'custom', message: 'An invitation needs a QR code for check-in', path: ['elements'] });
    if (!spec.elements.some((e) => e.type === 'text' && e.role === 'title'))
        ctx.addIssue({ code: 'custom', message: 'A design needs an event title', path: ['elements'] });
    for (const q of qrs) {
        if (q.type !== 'qr')
            continue;
        if (q.x < 0 || q.y < 0 || q.x + q.size > spec.canvas.width || q.y + q.size > spec.canvas.height)
            ctx.addIssue({ code: 'custom', message: 'The QR code must sit fully inside the canvas', path: ['elements'] });
    }
});
/** Validates untrusted data (a stored document, an API body, converter output) into a DesignSpec, or throws a ZodError. */
function parseDesignSpec(input) {
    return normalizeDesignSpec(exports.designSpecSchema.parse(input));
}
function safeParseDesignSpec(input) {
    const result = exports.designSpecSchema.safeParse(input);
    if (!result.success)
        return { ok: false, message: result.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'design'}: ${i.message}`).join('; ') };
    return { ok: true, spec: normalizeDesignSpec(result.data) };
}
/** Hook for future versions: upgrade older specs here so the renderer only ever sees the current shape. */
function normalizeDesignSpec(spec) {
    return spec;
}
// ---- colour helpers shared by the converter and the quality checks ----
function hexToRgb(color) {
    const n = parseInt(color.slice(1, 7), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
}
function luminance(color) {
    const [r, g, b] = hexToRgb(color).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastRatio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}
