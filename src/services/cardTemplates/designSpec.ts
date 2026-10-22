import { z } from 'zod';

// The LGPSM design specification: the only form in which an AI-generated (or hand-edited) design is stored and
// rendered. It is plain, closed data: positions, colours, bundled font names and *roles* that are filled with the
// event's real details at render time. It cannot hold markup, scripts, CSS, URLs, event details or a QR code, which
// is what makes a design safe to store and reuse for every event and every guest.
//
// Versioned so the renderer can keep reading old designs when the format grows: bump SPEC_VERSION and add a
// migration in `normalizeDesignSpec` rather than changing what version 1 means.

export const SPEC_VERSION = 1;

export const CANVAS_PRESETS = {
  INVITATION_PORTRAIT: { kind: 'INVITATION', width: 1080, height: 1920, label: 'Story / phone (9:16)' },
  INVITATION_CARD: { kind: 'INVITATION', width: 1080, height: 1350, label: 'Card (4:5)' },
  INVITATION_SQUARE: { kind: 'INVITATION', width: 1080, height: 1080, label: 'Square (1:1)' },
  POSTER_A4: { kind: 'POSTER', width: 1654, height: 2339, label: 'A4 poster (200 dpi)' },
  POSTER_PORTRAIT: { kind: 'POSTER', width: 1080, height: 1440, label: 'Portrait poster (3:4)' },
  POSTER_LANDSCAPE: { kind: 'POSTER', width: 1920, height: 1080, label: 'Landscape banner (16:9)' }
} as const;
export type CanvasPresetId = keyof typeof CANVAS_PRESETS;
export const CANVAS_PRESET_IDS = Object.keys(CANVAS_PRESETS) as [CanvasPresetId, ...CanvasPresetId[]];

export const MIN_CANVAS = 600;
export const MAX_CANVAS = 3508;
export const MAX_ELEMENTS = 60;

/** Families that ship with the app (src/assets/cardTemplates/fonts). Nothing is ever loaded from a CDN. */
export const SPEC_FONTS = ['Inter', 'Manrope', 'Playfair Display', 'Ancizar Serif', 'Alexandria', 'Alkatra', 'Alex Brush', 'Birthstone'] as const;
export type SpecFont = (typeof SPEC_FONTS)[number];

/** Fixed wording a design may carry. Event details are never part of a design: they are the text roles below. */
export const STATIC_LABELS = {
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
} as const;
export type StaticLabel = keyof typeof STATIC_LABELS;
export const STATIC_LABEL_IDS = Object.keys(STATIC_LABELS) as [StaticLabel, ...StaticLabel[]];

export const TEXT_ROLES = ['title', 'description', 'date', 'time', 'dateTime', 'venue', 'organizer', 'inviteeName', 'inviteeMeta', 'tagline', 'label'] as const;
export type TextRole = (typeof TEXT_ROLES)[number];

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colours must be #RRGGBB');
const px = (min: number, max: number) => z.number().finite().min(min).max(max);
const coord = px(-200, MAX_CANVAS + 200);
const length = px(0, MAX_CANVAS + 200);
const opacity = z.number().finite().min(0).max(1);

const base = { id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).optional() };

const fillSchema = z.union([
  hex,
  z.object({ type: z.literal('linear'), angle: px(0, 360), stops: z.array(hex).min(2).max(4) }).strict()
]);

export const rectElementSchema = z
  .object({ ...base, type: z.literal('rect'), x: coord, y: coord, w: length, h: length, radius: px(0, 2000).default(0), fill: fillSchema.optional(), stroke: hex.optional(), strokeWidth: px(0, 60).default(0), opacity: opacity.default(1) })
  .strict();
export const ellipseElementSchema = z
  .object({ ...base, type: z.literal('ellipse'), x: coord, y: coord, w: length, h: length, fill: fillSchema.optional(), stroke: hex.optional(), strokeWidth: px(0, 60).default(0), opacity: opacity.default(1) })
  .strict();
export const lineElementSchema = z
  .object({ ...base, type: z.literal('line'), x1: coord, y1: coord, x2: coord, y2: coord, stroke: hex, strokeWidth: px(0.5, 40).default(2), dash: z.boolean().default(false), opacity: opacity.default(1) })
  .strict();

export const textElementSchema = z
  .object({
    ...base,
    type: z.literal('text'),
    role: z.enum(TEXT_ROLES),
    /** Required (and only allowed) for role "label": one of the fixed phrases above */
    label: z.enum(STATIC_LABEL_IDS).optional(),
    x: coord,
    y: coord,
    w: px(20, MAX_CANVAS),
    h: px(10, MAX_CANVAS),
    align: z.enum(['left', 'center', 'right']).default('center'),
    valign: z.enum(['top', 'middle']).default('top'),
    fontFamily: z.enum(SPEC_FONTS),
    fontWeight: z.union([z.literal(400), z.literal(500), z.literal(600), z.literal(700)]).default(400),
    size: px(10, 400),
    minSize: px(8, 400).optional(),
    lineHeight: px(0.9, 2.5).default(1.2),
    letterSpacing: px(-5, 40).default(0),
    uppercase: z.boolean().default(false),
    maxLines: z.number().int().min(1).max(8).default(2),
    color: hex,
    opacity: opacity.default(1)
  })
  .strict()
  .superRefine((el, ctx) => {
    if (el.role === 'label' && !el.label) ctx.addIssue({ code: 'custom', message: 'A label needs one of the fixed phrases', path: ['label'] });
    if (el.role !== 'label' && el.label) ctx.addIssue({ code: 'custom', message: 'Only a label element carries a fixed phrase', path: ['label'] });
    if (el.minSize !== undefined && el.minSize > el.size) ctx.addIssue({ code: 'custom', message: 'minSize cannot exceed size', path: ['minSize'] });
  });

export const imageElementSchema = z
  .object({
    ...base,
    type: z.literal('image'),
    /** logo = the event's logo / organizer logo; photo = the event photo. Never a URL: the renderer supplies the image. */
    slot: z.enum(['logo', 'photo']),
    x: coord,
    y: coord,
    w: px(20, MAX_CANVAS),
    h: px(20, MAX_CANVAS),
    shape: z.enum(['rect', 'ellipse']).default('rect'),
    radius: px(0, 2000).default(0),
    fit: z.enum(['cover', 'contain']).default('cover'),
    /** Painted when the event has no image for the slot (an empty frame is better than nothing in a design) */
    placeholderFill: hex.optional()
  })
  .strict();

export const qrElementSchema = z
  .object({
    ...base,
    type: z.literal('qr'),
    /** INVITATION: the guest's own check-in QR. REGISTRATION: the event's registration / event link (posters). */
    purpose: z.enum(['INVITATION', 'REGISTRATION']),
    x: coord,
    y: coord,
    size: px(120, 1600),
    /** White quiet zone around the code, as a fraction of its size (QR readers need one) */
    padding: px(0.04, 0.2).default(0.08),
    radius: px(0, 200).default(0),
    frameColor: hex.optional()
  })
  .strict();

export const elementSchema = z.discriminatedUnion('type', [rectElementSchema, ellipseElementSchema, lineElementSchema, textElementSchema, imageElementSchema, qrElementSchema]);
export type SpecElement = z.infer<typeof elementSchema>;
export type SpecTextElement = z.infer<typeof textElementSchema>;

export const designSpecSchema = z
  .object({
    version: z.literal(SPEC_VERSION),
    kind: z.enum(['INVITATION', 'POSTER']),
    canvas: z
      .object({
        preset: z.enum(CANVAS_PRESET_IDS).optional(),
        width: z.number().int().min(MIN_CANVAS).max(MAX_CANVAS),
        height: z.number().int().min(MIN_CANVAS).max(MAX_CANVAS)
      })
      .strict()
      .refine((c) => c.width / c.height >= 0.4 && c.width / c.height <= 2.5, 'Unsupported aspect ratio'),
    background: fillSchema,
    palette: z.object({ background: hex, primary: hex, accent: hex, text: hex }).strict(),
    elements: z.array(elementSchema).min(1).max(MAX_ELEMENTS),
    /** Where the design came from; informational only, never used for rendering */
    meta: z.object({ generator: z.enum(['STITCH', 'MANUAL']).default('MANUAL'), archetype: z.string().max(40).optional(), styleNotes: z.array(z.string().max(80)).max(8).optional() }).strict().default({ generator: 'MANUAL' })
  })
  .strict()
  .superRefine((spec, ctx) => {
    const qrs = spec.elements.filter((e) => e.type === 'qr');
    if (qrs.length > 1) ctx.addIssue({ code: 'custom', message: 'A design has at most one QR code', path: ['elements'] });
    if (spec.kind === 'INVITATION' && qrs.some((q) => q.type === 'qr' && q.purpose === 'REGISTRATION'))
      ctx.addIssue({ code: 'custom', message: 'An invitation carries the guest QR code, not a registration link', path: ['elements'] });
    if (spec.kind === 'POSTER' && qrs.some((q) => q.type === 'qr' && q.purpose === 'INVITATION'))
      ctx.addIssue({ code: 'custom', message: 'A poster has no personal guest QR code', path: ['elements'] });
    if (spec.kind === 'INVITATION' && qrs.length === 0) ctx.addIssue({ code: 'custom', message: 'An invitation needs a QR code for check-in', path: ['elements'] });
    if (!spec.elements.some((e) => e.type === 'text' && e.role === 'title')) ctx.addIssue({ code: 'custom', message: 'A design needs an event title', path: ['elements'] });
    for (const q of qrs) {
      if (q.type !== 'qr') continue;
      if (q.x < 0 || q.y < 0 || q.x + q.size > spec.canvas.width || q.y + q.size > spec.canvas.height)
        ctx.addIssue({ code: 'custom', message: 'The QR code must sit fully inside the canvas', path: ['elements'] });
    }
  });

export type DesignSpec = z.infer<typeof designSpecSchema>;

/** Validates untrusted data (a stored document, an API body, converter output) into a DesignSpec, or throws a ZodError. */
export function parseDesignSpec(input: unknown): DesignSpec {
  return normalizeDesignSpec(designSpecSchema.parse(input));
}

export function safeParseDesignSpec(input: unknown): { ok: true; spec: DesignSpec } | { ok: false; message: string } {
  const result = designSpecSchema.safeParse(input);
  if (!result.success) return { ok: false, message: result.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'design'}: ${i.message}`).join('; ') };
  return { ok: true, spec: normalizeDesignSpec(result.data) };
}

/** Hook for future versions: upgrade older specs here so the renderer only ever sees the current shape. */
export function normalizeDesignSpec(spec: DesignSpec): DesignSpec {
  return spec;
}

// ---- colour helpers shared by the converter and the quality checks ----

export function hexToRgb(color: string): [number, number, number] {
  const n = parseInt(color.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
export function luminance(color: string): number {
  const [r, g, b] = hexToRgb(color).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
