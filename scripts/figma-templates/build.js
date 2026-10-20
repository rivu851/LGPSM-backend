#!/usr/bin/env node
/*
 * Builds the invitation-card template assets from the designers' Figma file.
 *
 *   node scripts/figma-templates/build.js "<path to Event_Management_Invitation_Card.fig folder>"
 *
 * Input : the unzipped .fig folder (canvas.fig + images/).
 * Output: src/assets/cardTemplates/<design>/background.png   the fixed artwork at 3x, with every dynamic part removed
 *         src/services/cardTemplates/layouts.generated.ts      where the dynamic parts go (text, photo, QR, logo, pin)
 *
 * The dynamic parts are drawn at request time by src/services/cardTemplates/renderer.ts, so one artwork serves every event.
 * Re-run this script (and commit the output) whenever the designers change the Figma file.
 * Needs Node >= 22.15 (built-in zstd, used by newer .fig files) and the dev dependency kiwi-schema.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');
const kiwi = require('kiwi-schema');
const { load, makeRenderer, id } = require('./fig2svg');

const figDir = process.argv[2];
if (!figDir) {
  console.error('Usage: node scripts/figma-templates/build.js <path to the .fig folder>');
  process.exit(1);
}
const ROOT = path.join(__dirname, '..', '..');
const ASSET_DIR = path.join(ROOT, 'src/assets/cardTemplates');
const LAYOUT_FILE = path.join(ROOT, 'src/services/cardTemplates/layouts.generated.ts');
const SCALE = 3;

// ---- 1. decode canvas.fig ----
function decodeFig(file) {
  const buf = fs.readFileSync(file);
  if (buf.slice(0, 8).toString() !== 'fig-kiwi') throw new Error('Not a .fig file');
  let off = 12;
  const chunks = [];
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32LE(off);
    off += 4;
    chunks.push(buf.slice(off, off + len));
    off += len;
  }
  const dec = (c) => (c.slice(0, 4).toString('hex') === '28b52ffd' ? zlib.zstdDecompressSync(c) : zlib.inflateRawSync(c));
  const schema = kiwi.compileSchema(kiwi.decodeBinarySchema(new Uint8Array(dec(chunks[0]))));
  return schema.decodeMessage(new Uint8Array(dec(chunks[1])));
}

// ---- 2. what each Figma frame is and which of its layers are dynamic ----
// `texts` maps a text layer's name in Figma to the slot it fills. `hide` lists layers that are placeholders for
// real content (sample photo, sample client logo, the pin that must follow the address text) and are not part of
// the fixed artwork.
const CARDS = [
  {
    frame: 'Corporate Invitation Card-V1',
    design: 'CORPORATE_V1',
    slug: 'corporate-v1',
    texts: {
      'Ultra Clear Excellence Awards': { slot: 'title', maxLines: 2, minSize: 20 },
      'Mr. Jagadish Harsh': { slot: 'inviteeName', maxLines: 1, minSize: 14, maxWidth: 329 },
      'Employee ID #51470A': { slot: 'inviteeMeta', maxLines: 1, minSize: 11 },
      'Event Date: 2nd November, 2026': { slot: 'datePill', maxLines: 1, minSize: 12, maxWidth: 300 },
      'Shanti Pally Ruby Crossing, Kol-700107': { slot: 'address', maxLines: 2, minSize: 11, inset: 0 },
    },
    hide: { names: ['logoipsum-229 1'], guids: ['138:299'] },
    logo: { name: 'logoipsum-229 1' },
    pin: { guid: '138:299', side: 'left' },
    qr: { box: 'Frame 7', pad: 10 },
  },
  {
    frame: 'Corporate Invitation Card-V2',
    design: 'CORPORATE_V2',
    slug: 'corporate-v2',
    texts: {
      'Leadership Summit': { slot: 'title', maxLines: 2, minSize: 18 },
      'Subhendu Bhattacharya': { slot: 'inviteeName', maxLines: 1, minSize: 14, maxWidth: 329 },
      'Managing Director of XYZ': { slot: 'inviteeMeta', maxLines: 1, minSize: 11 },
      'Scan the QR code': { slot: 'scanLabel', maxLines: 1, minSize: 10 },
      '2nd Nov to 5th Nov': { slot: 'datePill', maxLines: 1, minSize: 12, maxWidth: 270 },
      'Saltlake, Kolkata': { slot: 'address', maxLines: 1, minSize: 12, maxWidth: 300 },
    },
    hide: { names: ['logoipsum-229 1'], guids: ['48:3032'] },
    logo: { name: 'logoipsum-229 1' },
    pin: { guid: '48:3032', side: 'left' },
    qr: { box: 'Frame 7', pad: 10 },
  },
  {
    frame: 'Widding Reception Card',
    design: 'WEDDING',
    slug: 'wedding',
    texts: {
      'Moloy Roy & Dola Kar': { slot: 'names', maxLines: 2, minSize: 13, maxWidth: 290 },
      'are getting married': { slot: 'subline', maxLines: 2, minSize: 10, maxWidth: 280 },
      'Friday, 5:00 PM': { slot: 'timeLine', maxLines: 1, minSize: 11, maxWidth: 280 },
      '25': { slot: 'day', maxLines: 1, minSize: 14 },
      '12': { slot: 'month', maxLines: 1, minSize: 14 },
      '26': { slot: 'year', maxLines: 1, minSize: 14 },
      'Scan the QR code': { slot: 'scanLabel', maxLines: 1, minSize: 9 },
      'Saltlake, Kolkata': { slot: 'address', maxLines: 2, minSize: 11, maxWidth: 290 },
    },
    hide: { names: [], photoNode: 'Ellipse 5' },
    photo: { node: 'Ellipse 5', shape: 'ellipse' },
    qrFixed: { x: 141, y: 419, size: 113 },
  },
  {
    frame: 'Rice Ceremony Card',
    design: 'RICE_CEREMONY',
    slug: 'rice-ceremony',
    texts: {
      'Rice Ceremony': { slot: 'heading', maxLines: 1, minSize: 18, maxWidth: 250 },
      'of our beloved child': { slot: 'subline', maxLines: 1, minSize: 10, maxWidth: 220 },
      'Ayanika Chatterjee': { slot: 'honoree', maxLines: 2, minSize: 20, maxWidth: 270 },
      'Scan the QR code': { slot: 'scanLabel', maxLines: 1, minSize: 9 },
      'Friday, 12:30 pm': { slot: 'timeLine', maxLines: 1, minSize: 12, maxWidth: 240 },
      '13': { slot: 'day', maxLines: 1, minSize: 14 },
      '03': { slot: 'month', maxLines: 1, minSize: 14 },
      '27': { slot: 'year', maxLines: 1, minSize: 14 },
      '24, Shanti Pally, Near Ruby Crossing, Kolkata - 700107.': { slot: 'address', maxLines: 2, minSize: 9 },
    },
    hide: { names: [], photoNode: 'Frame 12' },
    photo: { node: 'Frame 12', shape: 'rect', radius: 4 },
    qr: { box: 'Frame 10', pad: 9 },
  },
  {
    frame: 'Birthday Card',
    design: 'BIRTHDAY',
    slug: 'birthday',
    texts: {
      'Please Join us to celebrate': { slot: 'intro', maxLines: 1, minSize: 10, maxWidth: 267 },
      'Srija Bhattacharya': { slot: 'honoree', maxLines: 2, minSize: 30, maxWidth: 331 },
      'Birthday Party': { slot: 'heading', maxLines: 1, minSize: 18, maxWidth: 280 },
      'Scan the QR code': { slot: 'scanLabel', maxLines: 1, minSize: 9 },
      January: { slot: 'month', maxLines: 1, minSize: 14, maxWidth: 170 },
      Wednesday: { slot: 'weekday', maxLines: 1, minSize: 11, maxWidth: 104 },
      '07': { slot: 'day', maxLines: 1, minSize: 30 },
      'At 10:00 PM': { slot: 'time', maxLines: 1, minSize: 11, maxWidth: 104 },
      '24, Shanti Pally, Near Ruby Crossing, Kolkata - 700107.': { slot: 'address', maxLines: 2, minSize: 9 },
    },
    hide: { names: [], photoNode: 'Ellipse 5' },
    photo: { node: 'Ellipse 5', shape: 'ellipse' },
    qr: { box: 'Frame 10', pad: 10 },
  },
];

// Layer names from Figma can contain non-breaking or zero-width spaces
const norm = (t) => String(t).normalize('NFKC').replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g, ' ').trim();

const FONT_WEIGHTS = { Thin: 100, 'Extra Light': 200, Light: 300, Regular: 400, Medium: 500, 'Semi Bold': 600, SemiBold: 600, Bold: 700, 'Extra Bold': 800, Black: 900 };

const textCfg = (card, name) => Object.entries(card.texts).find(([k]) => norm(k) === norm(name))?.[1];

(async () => {
  const msg = decodeFig(path.join(figDir, 'canvas.fig'));
  fs.writeFileSync(path.join(__dirname, '.canvas.tmp.json'), JSON.stringify(msg, (k, v) => (v instanceof Uint8Array ? { __bytes: Array.from(v) } : typeof v === 'bigint' ? v.toString() : v)));
  const doc = load(path.join(__dirname, '.canvas.tmp.json'));
  fs.unlinkSync(path.join(__dirname, '.canvas.tmp.json'));

  const docNode = doc.m.nodeChanges.find((n) => n.type === 'DOCUMENT');
  const page = (doc.kids.get(id(docNode.guid)) || []).find((p) => p.name === 'Main Page');
  const frames = doc.kids.get(id(page.guid));

  const descendants = (n) => (doc.kids.get(id(n.guid)) || []).flatMap((c) => [c, ...descendants(c)]);
  const absMatrix = (n, top) => {
    let M = [1, 0, 0, 1, 0, 0];
    const chain = [];
    for (let c = n; c && c !== top; c = doc.byId.get(id(c.parentIndex?.guid))) chain.unshift(c);
    for (const k of chain) {
      const t = k.transform;
      const A = [t.m00, t.m10, t.m01, t.m11, t.m02, t.m12];
      M = [M[0] * A[0] + M[2] * A[1], M[1] * A[0] + M[3] * A[1], M[0] * A[2] + M[2] * A[3], M[1] * A[2] + M[3] * A[3], M[0] * A[4] + M[2] * A[5] + M[4], M[1] * A[4] + M[3] * A[5] + M[5]];
    }
    return M;
  };
  const box = (n, top) => {
    const M = absMatrix(n, top);
    return { x: +M[4].toFixed(2), y: +M[5].toFixed(2), w: +(n.size.x * Math.abs(M[0])).toFixed(2), h: +(n.size.y * Math.abs(M[3])).toFixed(2) };
  };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  const IMAGES = path.join(figDir, 'images');

  const layouts = {};
  for (const card of CARDS) {
    const top = frames.find((f) => f.name === card.frame);
    if (!top) throw new Error('Frame not found: ' + card.frame);
    const all = descendants(top);
    const byName = (name) => all.find((n) => norm(n.name) === norm(name) && n.visible !== false);

    // layers to leave out of the fixed artwork
    const hide = new Set();
    for (const n of all) {
      if ((card.hide.names || []).some((h) => norm(h) === norm(n.name)) || (card.hide.guids || []).includes(id(n.guid)) || (card.hide.photoNode && n.name === card.hide.photoNode && n.type !== 'FRAME') || (card.hide.photoNode === 'Frame 12' && n.name === 'Frame 12')) hide.add(id(n.guid));
    }

    // fixed artwork
    const renderer = makeRenderer(doc, IMAGES, { maxImage: 2000, hide });
    const svg = await renderer.frameSvg(top, SCALE);
    const dir = path.join(ASSET_DIR, card.slug);
    fs.mkdirSync(dir, { recursive: true });
    await sharp(Buffer.from(svg), { density: 72 }).png({ compressionLevel: 9, palette: false }).toFile(path.join(dir, 'background.png'));

    // text slots
    const texts = {};
    for (const n of all) {
      if (n.type !== 'TEXT' || n.visible === false) continue;
      const cfg = textCfg(card, n.name);
      if (!cfg) continue;
      const b = box(n, top);
      const bl = n.derivedTextData?.baselines?.[0];
      const fill = (n.fillPaints || []).find((p) => p.visible !== false && p.type === 'SOLID');
      texts[cfg.slot] = {
        sample: n.textData.characters.trim(),
        cx: +(b.x + b.w / 2).toFixed(2),
        top: b.y,
        boxWidth: b.w,
        baseline: +(b.y + (bl ? bl.position.y : n.fontSize)).toFixed(2),
        lineHeight: bl ? bl.lineHeight : Math.round(n.fontSize * 1.2),
        // how many lines the designers' box held; fewer lines at runtime are centred in the same space
        designLines: Math.max(1, Math.round(b.h / (bl ? bl.lineHeight : n.fontSize * 1.2))),
        fontFamily: n.fontName.family,
        fontWeight: FONT_WEIGHTS[n.fontName.style] || 400,
        fontSize: n.fontSize,
        color: fill ? hex(fill.color) : '#000000',
        letterSpacing: n.letterSpacing && n.letterSpacing.units === 'PIXELS' ? n.letterSpacing.value : 0,
        maxLines: cfg.maxLines,
        minSize: cfg.minSize,
        // fixed-width boxes in Figma wrap at their own width; others use the width of the artwork's content area
        maxWidth: cfg.maxWidth || (n.textAutoResize === 'HEIGHT' ? b.w : 0),
      };
    }
    for (const name of Object.keys(card.texts)) if (!Object.values(texts).some((t) => norm(t.sample) === norm(name))) console.warn(`  ! text layer not found: ${card.frame} / ${name}`);

    const layout = { design: card.design, width: top.size.x, height: top.size.y, texts };

    if (card.photo) {
      const n = all.find((x) => x.name === card.photo.node && (card.photo.node !== 'Frame 12' || x.type === 'FRAME'));
      layout.photo = { shape: card.photo.shape, radius: card.photo.radius || 0, ...(({ x, y, w, h }) => ({ x, y, w, h }))(box(n, top)) };
    }
    if (card.logo) {
      const n = byName(card.logo.name);
      layout.logo = (({ x, y, w, h }) => ({ x, y, w, h }))(box(n, top));
    }
    if (card.qr) {
      const b = box(byName(card.qr.box), top);
      layout.qr = { x: +(b.x + card.qr.pad).toFixed(2), y: +(b.y + card.qr.pad).toFixed(2), size: +(Math.min(b.w, b.h) - card.qr.pad * 2).toFixed(2) };
    } else if (card.qrFixed) layout.qr = card.qrFixed;
    if (card.pin) {
      const n = all.find((x) => id(x.guid) === card.pin.guid);
      const b = box(n, top);
      const g = n.fillGeometry[0];
      const bytes = Uint8Array.from(doc.m.blobs[g.commandsBlob].bytes.__bytes);
      const dv = new DataView(bytes.buffer);
      let o = 0;
      let d = '';
      const f = () => { const v = dv.getFloat32(o, true); o += 4; return +v.toFixed(3); };
      while (o < bytes.length) {
        const c = bytes[o++];
        if (c === 0) d += 'Z';
        else if (c === 1) d += `M${f()} ${f()}`;
        else if (c === 2) d += `L${f()} ${f()}`;
        else if (c === 3) d += `Q${f()} ${f()} ${f()} ${f()}`;
        else d += `C${f()} ${f()} ${f()} ${f()} ${f()} ${f()}`;
      }
      const fill = (n.fillPaints || []).find((p) => p.visible !== false && p.type === 'SOLID');
      layout.pin = { d, w: b.w, h: b.h, offsetY: +(b.y - texts.address.top).toFixed(2), color: fill ? hex(fill.color) : '#000000', side: card.pin.side };
    }
    layouts[card.design] = { ...layout, background: `${card.slug}/background.png` };
    const kb = (fs.statSync(path.join(dir, 'background.png')).size / 1024).toFixed(0);
    console.log(`${card.design.padEnd(14)} background ${kb} KB, ${Object.keys(texts).length} text slots${layout.photo ? ', photo' : ''}${layout.qr ? ', qr' : ''}${layout.logo ? ', logo' : ''}${layout.pin ? ', pin' : ''}`);
  }

  fs.mkdirSync(path.dirname(LAYOUT_FILE), { recursive: true });
  const header = `// GENERATED by scripts/figma-templates/build.js from the designers' Figma file. Do not edit by hand:\n// change the Figma file (or the script's mapping) and re-run the script.\n// Coordinates are in Figma pixels (the card is ${layouts.BIRTHDAY.width} x ${layouts.BIRTHDAY.height}); the renderer scales them.\n\n`;
  const body = `export interface TextSlotLayout {\n  /** Text the designers used; shown in template previews */\n  sample: string;\n  cx: number;\n  top: number;\n  boxWidth: number;\n  baseline: number;\n  lineHeight: number;\n  designLines: number;\n  fontFamily: string;\n  fontWeight: number;\n  fontSize: number;\n  color: string;\n  letterSpacing: number;\n  maxLines: number;\n  minSize: number;\n  /** widest the text may be (Figma px); 0 = use the symmetric default */\n  maxWidth: number;\n}\n\nexport interface CardLayout {\n  design: string;\n  width: number;\n  height: number;\n  background: string;\n  texts: Record<string, TextSlotLayout>;\n  photo?: { shape: 'ellipse' | 'rect'; radius: number; x: number; y: number; w: number; h: number };\n  logo?: { x: number; y: number; w: number; h: number };\n  qr?: { x: number; y: number; size: number };\n  pin?: { d: string; w: number; h: number; offsetY: number; color: string; side: 'left' };\n}\n\nexport const CARD_LAYOUTS: Record<string, CardLayout> = ${JSON.stringify(layouts, null, 2)};\n`;
  fs.writeFileSync(LAYOUT_FILE, header + body);
  console.log('wrote', path.relative(ROOT, LAYOUT_FILE));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
