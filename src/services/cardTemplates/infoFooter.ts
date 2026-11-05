import sharp from 'sharp';
import { ensureCardFonts, fontStack, measureText } from './fonts';
import { LAYOUTS } from './layoutOverrides';

/**
 * The part of the card that extends below the artwork. Every design gets "For more details contact <number>" here, and the
 * designs that have no guest lines in their artwork (Wedding, Rice Ceremony, Birthday) get the guest's name and additional
 * information here too. The artwork is fixed (frames, date bands and pins are part of the picture), so this extension is what
 * lets all of a card's dynamic details appear on every design. It is only as tall as the lines it holds and is not added at all
 * when there is nothing to say, so a card without a contact number or guest lines is exactly the designed card.
 */
export type FooterRow = { kind: 'title' | 'when' | 'where' | 'name' | 'meta' | 'contact'; text: string };

export interface FooterStyle {
  /** main text colour */
  ink: string;
  /** colour of the second guest line */
  accent: string;
}

const LABEL = 'For more details contact ';
const FAMILY = 'Inter';
const SIDE = 24; // Figma px kept clear at the left and right edges
const REF_WIDTH = 393; // the Figma frame; sizes below are in these px and scale with the card's width
const escapeXml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// eslint-disable-next-line no-control-regex
const clean = (t?: string) => (t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const hexOf = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** Breaks text into at most `maxLines` lines no wider than `maxWidth`, shrinking the type (down to `minSize`) before it ever cuts anything */
async function wrapFit(text: string, weight: number, size: number, minSize: number, maxWidth: number, maxLines: number): Promise<{ lines: string[]; size: number }> {
  // a range ("start – end") breaks at the dash, so neither end is split across lines
  const halves = maxLines > 1 && text.includes(' – ') ? [text.slice(0, text.indexOf(' – ') + 2), text.slice(text.indexOf(' – ') + 3)] : null;
  if (halves) {
    if ((await measureText(text, FAMILY, weight, size)) <= maxWidth) return { lines: [text], size };
    for (let s = size; s >= minSize - 0.01; s -= 0.5) {
      const widths = await Promise.all(halves.map((h) => measureText(h, FAMILY, weight, s)));
      if (widths.every((w) => w <= maxWidth)) return { lines: halves, size: s };
    }
  }
  const words = text.split(' ');
  for (let s = size; s >= minSize - 0.01; s -= 0.5) {
    const lines: string[] = [];
    let cur = '';
    let ok = true;
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if ((await measureText(next, FAMILY, weight, s)) <= maxWidth) cur = next;
      else if (!cur) { ok = false; break; } // one word wider than the line
      else { lines.push(cur); cur = w; }
    }
    if (!ok) continue;
    lines.push(cur);
    if (lines.length <= maxLines) return { lines, size: s };
  }
  // does not fit even at the smallest size: keep what fits and end with an ellipsis
  const s = minSize;
  const lines: string[] = [];
  let rest = text;
  while (rest && lines.length < maxLines) {
    let end = rest.length;
    while (end > 1 && (await measureText(rest.slice(0, end).trimEnd(), FAMILY, weight, s)) > maxWidth) end -= 1;
    const last = lines.length === maxLines - 1 && end < rest.length;
    let chunk = rest.slice(0, end).trimEnd();
    if (last) { while (chunk.length > 1 && (await measureText(`${chunk}…`, FAMILY, weight, s)) > maxWidth) chunk = chunk.slice(0, -1).trimEnd(); chunk += '…'; }
    else if (end < rest.length && chunk.includes(' ')) chunk = chunk.slice(0, chunk.lastIndexOf(' '));
    lines.push(chunk);
    rest = rest.slice(chunk.replace(/…$/, '').length).trimStart();
  }
  return { lines, size: s };
}

// size, weight, colour role, line limit and the gap after, per kind of row
const ROW_STYLE: Record<FooterRow['kind'], { size: number; min: number; weight: number; tone: 'ink' | 'accent' | 'muted'; lines: number; gap: number }> = {
  title: { size: 17, min: 11, weight: 700, tone: 'ink', lines: 2, gap: 6 },
  when: { size: 13, min: 9, weight: 600, tone: 'muted', lines: 2, gap: 8 },
  where: { size: 13, min: 9, weight: 500, tone: 'muted', lines: 2, gap: 8 },
  name: { size: 22, min: 12, weight: 700, tone: 'ink', lines: 1, gap: 6 },
  meta: { size: 15, min: 10, weight: 700, tone: 'accent', lines: 1, gap: 6 },
  contact: { size: 12.5, min: 9, weight: 500, tone: 'muted', lines: 1, gap: 0 }
};

interface Placed { kind: FooterRow['kind']; lines: string[]; size: number; baseline: number[]; raw: string }

export async function appendInfoFooter(png: Buffer, allRows: FooterRow[], style: FooterStyle): Promise<Buffer> {
  const rows = allRows.map((r) => ({ ...r, text: clean(r.text) })).filter((r) => r.text);
  if (!rows.length) return png;

  await ensureCardFonts();
  const info = await sharp(png).metadata();
  const width = info.width || 0;
  const height = info.height || 0;
  if (!width || !height) return png;
  const k = width / REF_WIDTH;
  const maxWidth = (REF_WIDTH - 2 * SIDE) * k;

  // 1. lay the lines out (colour does not matter yet)
  const placed: Placed[] = [];
  let y = 18 * k; // padding above the first line
  for (const row of rows) {
    const st = ROW_STYLE[row.kind];
    if (row.kind === 'contact') {
      if (rows.length > 1) y += 4 * k;
      const full = `${LABEL}${row.text}`;
      const fit = await wrapFit(full, st.weight, st.size * k, st.min * k, maxWidth, 1);
      y += fit.size;
      placed.push({ kind: row.kind, lines: fit.lines, size: fit.size, baseline: [y], raw: row.text });
      y += 4 * k;
      continue;
    }
    const fit = await wrapFit(row.text, st.weight, st.size * k, st.min * k, maxWidth, st.lines);
    const baseline = fit.lines.map((_, i) => { y += i === 0 ? fit.size : fit.size * 1.25; return y; });
    placed.push({ kind: row.kind, lines: fit.lines, size: fit.size, baseline, raw: row.text });
    y += st.gap * k;
  }
  const footerHeight = Math.ceil(y + 22 * k); // padding below the last line

  // 2. The extension carries the artwork on: the card's own bottom edge is stretched down and softened, so its colour or
  //    texture simply continues (no panel, no seam, nothing of the artwork repeated). A transparent edge stays transparent.
  // The edge is reduced to a few average colours across the width and spread smoothly down: the card's colour carries on without
  // repeating any of its drawing.
  const edge = Math.min(12, height);
  // (two separate steps: sharp applies only the last resize of a chain)
  const averages = await sharp(png)
    .extract({ left: 0, top: height - edge, width, height: edge })
    .resize({ width: 8, height: 1, fit: 'fill', kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const extension = await sharp(averages)
    .resize({ width, height: footerHeight, fit: 'fill', kernel: 'cubic' })
    .blur(6)
    .png()
    .toBuffer();

  // 3. text colour follows what is behind it: dark text on a light background, white on a dark one
  const backdrop = await sharp(extension).flatten({ background: '#FFFFFF' }).resize(1, 1, { kernel: 'cubic' }).raw().toBuffer();
  const dark = luminance(hexOf(backdrop[0], backdrop[1], backdrop[2])) < 0.3;
  const colour = dark
    ? { ink: '#FFFFFF', accent: '#FFE2C2', muted: '#F2F2F2' }
    : { ink: '#111111', accent: style.accent, muted: '#222222' };

  const family = escapeXml(fontStack(FAMILY));
  const out: string[] = [];
  for (const p of placed) {
    const st = ROW_STYLE[p.kind];
    if (p.kind === 'contact') {
      const full = `${LABEL}${p.raw}`;
      const content = p.lines[0] === full
        ? `${escapeXml(LABEL)}<tspan font-weight="700" fill="${colour.ink}">${escapeXml(p.raw)}</tspan>`
        : escapeXml(p.lines[0]);
      out.push(`<text x="${width / 2}" y="${p.baseline[0]}" text-anchor="middle" font-family="${family}" font-weight="${st.weight}" font-size="${p.size}" fill="${colour.muted}">${content}</text>`);
      continue;
    }
    p.lines.forEach((line, i) => out.push(`<text x="${width / 2}" y="${p.baseline[i]}" text-anchor="middle" font-family="${family}" font-weight="${st.weight}" font-size="${p.size}" fill="${colour[st.tone]}">${escapeXml(line)}</text>`));
  }
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${footerHeight}" viewBox="0 0 ${width} ${footerHeight}">${out.join('')}</svg>`);
  return sharp({ create: { width, height: height + footerHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: png, top: 0, left: 0 }, { input: extension, top: height, left: 0 }, { input: svg, top: height, left: 0 }])
    .png({ compressionLevel: 6 })
    .toBuffer();
}

const TEXTURED = new Set(['BIRTHDAY']);

/**
 * Puts the guest's name (large) and second line into the artwork itself, for designs whose picture has no place for them.
 * The picture is cut at an empty row just under its "Scan the QR code" label (found from the design's own layout), that row is
 * stretched to open a band of the height the text needs, and everything below moves down. Nothing is covered or redrawn:
 * the whole card stays visible, only taller. Returns the card unchanged when the design has no such row or there is no name.
 */
export async function insertGuestBand(png: Buffer, design: string, nameText: string, metaText: string | undefined, style: FooterStyle): Promise<Buffer> {
  const name = clean(nameText);
  const meta = clean(metaText);
  const layout = LAYOUTS[design];
  const label = layout?.texts?.scanLabel;
  if (!name || !layout || !label) return png;
  await ensureCardFonts();
  const info = await sharp(png).metadata();
  const width = info.width || 0;
  const height = info.height || 0;
  if (!width || !height) return png;
  const k = width / layout.width;
  const cut = Math.round((label.baseline + 0.3 * label.fontSize + 2) * k);
  if (cut < 4 || cut >= height - 4) return png;
  const maxWidth = 250 * k;

  const nameFit = await wrapFit(name, 700, 24 * k, 13 * k, maxWidth, 1);
  const metaFit = meta ? await wrapFit(meta, 700, 15 * k, 10 * k, maxWidth, 1) : null;
  const pad = 8 * k;
  const baselineName = pad + nameFit.size;
  const baselineMeta = baselineName + (metaFit ? 5 * k + metaFit.size : 0);
  const band = Math.ceil(baselineMeta + pad + 4 * k);

  // the row just above the cut is empty background: stretched, it carries the card's colour (and its frame edges) through the band
  // a textured background (paper, confetti) would show as streaks when stretched, so it is smoothed; flat designs keep their crisp frame edges
  let stretched = sharp(png).extract({ left: 0, top: cut - 3, width, height: 3 }).resize({ width, height: band, fit: 'fill', kernel: 'nearest' });
  if (TEXTURED.has(design)) stretched = sharp(await stretched.png().toBuffer()).blur(12);
  const rows = await stretched.png().toBuffer();
  const sample = await sharp(rows).flatten({ background: '#FFFFFF' }).extract({ left: Math.round(width / 2) - 20, top: 0, width: 40, height: 1 }).resize(1, 1).raw().toBuffer();
  const dark = luminance(hexOf(sample[0], sample[1], sample[2])) < 0.3;
  const family = escapeXml(fontStack(FAMILY));
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${band}" viewBox="0 0 ${width} ${band}">` +
      `<text x="${width / 2}" y="${baselineName}" text-anchor="middle" font-family="${family}" font-weight="700" font-size="${nameFit.size}" fill="${dark ? '#FFFFFF' : style.ink}">${escapeXml(nameFit.lines[0])}</text>` +
      (metaFit ? `<text x="${width / 2}" y="${baselineMeta}" text-anchor="middle" font-family="${family}" font-weight="700" font-size="${metaFit.size}" fill="${dark ? '#FFE2C2' : style.accent}">${escapeXml(metaFit.lines[0])}</text>` : '') +
      '</svg>'
  );
  const upper = await sharp(png).extract({ left: 0, top: 0, width, height: cut }).png().toBuffer();
  const lower = await sharp(png).extract({ left: 0, top: cut, width, height: height - cut }).png().toBuffer();
  return sharp({ create: { width, height: height + band, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: upper, top: 0, left: 0 }, { input: rows, top: cut, left: 0 }, { input: svg, top: cut, left: 0 }, { input: lower, top: cut + band, left: 0 }])
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/** Ink and accent colours that go with each fixed design, taken from the colours the designers used for its text */
export const FOOTER_STYLES: Record<string, FooterStyle> = {
  CORPORATE_V1: { ink: '#004387', accent: '#E8851A' },
  CORPORATE_V2: { ink: '#0F3190', accent: '#E3340F' },
  WEDDING: { ink: '#202020', accent: '#6B5B3E' },
  RICE_CEREMONY: { ink: '#660410', accent: '#D68A2D' },
  BIRTHDAY: { ink: '#794807', accent: '#B8862B' },
  CLASSIC: { ink: '#232222', accent: '#CF5317' },
};
