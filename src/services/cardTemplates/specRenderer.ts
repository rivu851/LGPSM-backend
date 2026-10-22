import sharp from 'sharp';
import { DesignSpec, SpecElement, SpecTextElement, STATIC_LABELS, TextRole } from './designSpec';
import { ensureCardFonts, fontStack, measureText } from './fonts';

// Draws a DesignSpec (see designSpec.ts) with the event's real content, using the same engine and bundled fonts as
// the Figma-based cards: sharp composites images and one SVG of shapes and text per run of vector elements. Only
// validated spec values reach the SVG and every piece of text is escaped, so nothing a generator or an organizer
// supplies can become markup, script, a font download or a network request.

const MAX_TEXT_LENGTH = 400;
const MAX_OUTPUT_EDGE = 4096;
const FIT_STEP = 0.04;

export type SpecTexts = Partial<Record<TextRole, string>>;

export interface SpecRenderInput {
  spec: DesignSpec;
  /** role -> text. A missing or blank role leaves that text empty (the design must still look right). */
  texts: SpecTexts;
  photo?: Buffer | null;
  logo?: Buffer | null;
  /** QR code image (PNG) for the design's QR element */
  qr?: Buffer | null;
  /** Output pixels per canvas px (1 = the canvas size). Clamped so no side exceeds 4096 px. */
  scale?: number;
  /** Previews only: empty image frames show their placeholder colour */
  showPlaceholders?: boolean;
}

export interface SpecRenderResult {
  png: Buffer;
  width: number;
  height: number;
  /** Things worth knowing that did not stop the render: text that was shortened, a missing QR, an unreadable image */
  warnings: string[];
}

const escapeXml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// eslint-disable-next-line no-control-regex
const cleanText = (t: string) => t.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---- text fitting ----

interface FittedBlock {
  lines: string[];
  size: number;
  truncated: boolean;
}

async function fitBlock(el: SpecTextElement, raw: string): Promise<FittedBlock> {
  let text = cleanText(raw);
  if (el.uppercase) text = text.toLocaleUpperCase();
  const words = text.split(' ').filter(Boolean);
  const minSize = el.minSize ?? Math.max(8, el.size * 0.55);
  const ref = 100;
  const widths = new Map<string, number>();
  for (const w of new Set(words)) widths.set(w, await measureText(w, el.fontFamily, el.fontWeight, ref));
  const space = Math.max(1, (await measureText('n n', el.fontFamily, el.fontWeight, ref)) - (await measureText('nn', el.fontFamily, el.fontWeight, ref)));
  const lineWidth = (ws: string[], size: number) =>
    ((ws.reduce((s, w) => s + (widths.get(w) || 0), 0) + Math.max(0, ws.length - 1) * space) * size) / ref + el.letterSpacing * ws.join(' ').length;

  const wrap = (size: number): string[][] => {
    const lines: string[][] = [];
    let cur: string[] = [];
    for (const w of words) {
      if (cur.length === 0 || lineWidth([...cur, w], size) <= el.w) cur.push(w);
      else {
        lines.push(cur);
        cur = [w];
      }
    }
    if (cur.length) lines.push(cur);
    return lines;
  };
  const fits = (lines: string[][], size: number) => lines.length <= el.maxLines && lines.length * size * el.lineHeight <= el.h + 0.5 && lines.every((l) => lineWidth(l, size) <= el.w + 0.5);

  let size = el.size;
  let lines = wrap(size);
  while (!fits(lines, size) && size - el.size * FIT_STEP >= minSize) {
    size = r2(size - el.size * FIT_STEP);
    lines = wrap(size);
  }
  let rendered = lines.map((l) => l.join(' '));
  // confirm with exact measurements: the per-word estimate can be a hair optimistic
  const exact = (l: string, s: number) => measureText(l, el.fontFamily, el.fontWeight, s).then((w) => w + el.letterSpacing * l.length);
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
    const overflow = async (l: string) => (await exact(l, size)) > el.w + 0.5;
    if (truncated || (await overflow(last))) {
      if (truncated) last = `${last}…`;
      while (last.length > 1 && (await overflow(last))) last = `${last.replace(/…$/, '').slice(0, -1).trimEnd()}…`;
      rendered[rendered.length - 1] = last;
      truncated = true;
    }
  }
  return { lines: rendered, size, truncated };
}

// ---- vector layers ----

class SvgChunk {
  private defs: string[] = [];
  private body: string[] = [];
  private gradients = 0;
  constructor(private readonly s: number) {}

  get empty() {
    return this.body.length === 0;
  }

  fill(fill: unknown, box: { x: number; y: number; w: number; h: number }): string {
    if (typeof fill === 'string') return `fill="${fill}"`;
    if (fill && typeof fill === 'object' && (fill as any).type === 'linear') {
      const f = fill as { angle: number; stops: string[] };
      const id = `g${this.gradients++}`;
      const rad = ((f.angle - 90) * Math.PI) / 180;
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const dx = (Math.cos(rad) * box.w) / 2;
      const dy = (Math.sin(rad) * box.h) / 2;
      this.defs.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${r2((cx - dx) * this.s)}" y1="${r2((cy - dy) * this.s)}" x2="${r2((cx + dx) * this.s)}" y2="${r2((cy + dy) * this.s)}">${f.stops
          .map((c, i) => `<stop offset="${r2((i / (f.stops.length - 1)) * 100)}%" stop-color="${c}"/>`)
          .join('')}</linearGradient>`
      );
      return `fill="url(#${id})"`;
    }
    return 'fill="none"';
  }

  add(markup: string) {
    this.body.push(markup);
  }

  toSvg(width: number, height: number): Buffer {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${this.defs.join('')}</defs>${this.body.join('')}</svg>`);
  }
}

const strokeAttrs = (el: { stroke?: string; strokeWidth?: number }, s: number) => (el.stroke && (el.strokeWidth || 0) > 0 ? ` stroke="${el.stroke}" stroke-width="${r2((el.strokeWidth as number) * s)}"` : '');

async function shapedImage(image: Buffer, el: { w: number; h: number; shape: 'rect' | 'ellipse'; radius: number; fit: 'cover' | 'contain' }, s: number): Promise<Buffer> {
  const w = Math.max(1, Math.round(el.w * s));
  const h = Math.max(1, Math.round(el.h * s));
  const fitted = await sharp(image, { failOn: 'none', limitInputPixels: 40_000_000 })
    .rotate()
    .resize(w, h, el.fit === 'cover' ? { fit: 'cover', position: sharp.strategy.attention } : { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png()
    .toBuffer();
  if (el.shape === 'rect' && el.radius <= 0) return fitted;
  const mask =
    el.shape === 'ellipse'
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#fff"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r2(el.radius * s)}" fill="#fff"/></svg>`;
  return sharp(fitted).composite([{ input: Buffer.from(mask), blend: 'dest-in' }]).png().toBuffer();
}

async function qrLayer(qr: Buffer, size: number, padding: number, radius: number, frameColor: string, s: number): Promise<Buffer> {
  const outer = Math.max(1, Math.round(size * s));
  const pad = Math.round(outer * (padding / (1 + 2 * padding)));
  const inner = Math.max(1, outer - 2 * pad);
  let source = qr;
  try {
    // the QR library adds its own margin: trim it so the quiet zone is exactly the design's padding
    source = await sharp(qr).trim({ threshold: 10 }).png().toBuffer();
  } catch {
    source = qr;
  }
  const code = await sharp(source).resize(inner, inner, { fit: 'fill', kernel: 'nearest' }).png().toBuffer();
  const frame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${outer}" height="${outer}"><rect width="${outer}" height="${outer}" rx="${r2(radius * s)}" fill="${frameColor}"/></svg>`);
  return sharp(frame).composite([{ input: code, left: pad, top: pad }]).png().toBuffer();
}

/** Text for a text element: a fixed phrase for labels, otherwise the event's value for its role. */
function textFor(el: SpecTextElement, texts: SpecTexts): string {
  if (el.role === 'label') return el.label ? STATIC_LABELS[el.label] : '';
  return texts[el.role] || '';
}

export function outputSize(spec: DesignSpec, scale = 1): { width: number; height: number; scale: number } {
  const s = Math.min(scale > 0 ? scale : 1, MAX_OUTPUT_EDGE / Math.max(spec.canvas.width, spec.canvas.height));
  return { width: Math.round(spec.canvas.width * s), height: Math.round(spec.canvas.height * s), scale: s };
}

export async function renderDesignSpec(input: SpecRenderInput): Promise<SpecRenderResult> {
  const { spec } = input;
  await ensureCardFonts();
  const { width, height, scale: s } = outputSize(spec, input.scale);
  const warnings: string[] = [];

  const layers: Array<{ input: Buffer; left: number; top: number }> = [];
  let chunk = new SvgChunk(s);
  const flush = () => {
    if (!chunk.empty) layers.push({ input: chunk.toSvg(width, height), left: 0, top: 0 });
    chunk = new SvgChunk(s);
  };

  for (const el of spec.elements as SpecElement[]) {
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
        if (!cleanText(value)) break;
        const fitted = await fitBlock(el, value);
        if (fitted.truncated) warnings.push(`The ${el.role} text was shortened to fit its space`);
        const lh = fitted.size * el.lineHeight;
        const top = el.valign === 'middle' ? el.y + (el.h - fitted.lines.length * lh) / 2 : el.y;
        const anchor = el.align === 'left' ? 'start' : el.align === 'right' ? 'end' : 'middle';
        const ax = el.align === 'left' ? el.x : el.align === 'right' ? el.x + el.w : el.x + el.w / 2;
        fitted.lines.forEach((line, i) => {
          chunk.add(
            `<text x="${r2(ax * s)}" y="${r2((top + i * lh + (lh - fitted.size) / 2 + fitted.size * 0.8) * s)}" text-anchor="${anchor}" font-family="${escapeXml(fontStack(el.fontFamily))}" font-weight="${el.fontWeight}" font-size="${r2(fitted.size * s)}" fill="${el.color}" fill-opacity="${el.opacity}"${el.letterSpacing ? ` letter-spacing="${r2(el.letterSpacing * s)}"` : ''}>${escapeXml(line)}</text>`
          );
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
          } catch (err) {
            warnings.push(`The ${el.slot} image could not be used`);
            console.warn('[cards] Spec image could not be used:', err instanceof Error ? err.message : 'unknown error');
          }
        }
        if (input.showPlaceholders && el.placeholderFill) {
          chunk.add(
            el.shape === 'ellipse'
              ? `<ellipse cx="${r2((el.x + el.w / 2) * s)}" cy="${r2((el.y + el.h / 2) * s)}" rx="${r2((el.w / 2) * s)}" ry="${r2((el.h / 2) * s)}" fill="${el.placeholderFill}"/>`
              : `<rect x="${r2(el.x * s)}" y="${r2(el.y * s)}" width="${r2(el.w * s)}" height="${r2(el.h * s)}" rx="${r2(el.radius * s)}" fill="${el.placeholderFill}"/>`
          );
        }
        break;
      }
      case 'qr': {
        if (!input.qr) {
          warnings.push(el.purpose === 'INVITATION' ? 'No invitation QR code was supplied' : 'No registration link was supplied, so the QR code was left out');
          break;
        }
        flush();
        layers.push({ input: await qrLayer(input.qr, el.size, el.padding, el.radius, el.frameColor || '#FFFFFF', s), left: Math.round(el.x * s), top: Math.round(el.y * s) });
        break;
      }
    }
  }
  flush();

  const bg = new SvgChunk(s);
  const fill = bg.fill(spec.background, { x: 0, y: 0, w: spec.canvas.width, h: spec.canvas.height });
  bg.add(`<rect width="${width}" height="${height}" ${fill}/>`);
  const png = await sharp(bg.toSvg(width, height)).composite(layers).png({ compressionLevel: 9 }).toBuffer();
  return { png, width, height, warnings };
}
