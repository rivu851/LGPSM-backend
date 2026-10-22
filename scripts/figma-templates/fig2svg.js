// Converts a frame of a decoded Figma (.fig) document into a standalone SVG.
// Supported: frames (clip), groups, vectors/ellipses/rounded rectangles (from stored path geometry), solid /
// linear-gradient / image fills, strokes (from stored outlines), OUTLINE and LUMINANCE masks, opacity.
// TEXT layers are not drawn (they are the dynamic slots).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const id = (g) => g && `${g.sessionID}:${g.localID}`;
const num = (v) => (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(4));

function load(canvasJson) {
  const m = JSON.parse(fs.readFileSync(canvasJson, 'utf8'));
  const byId = new Map();
  const kids = new Map();
  m.nodeChanges.forEach((n) => byId.set(id(n.guid), n));
  m.nodeChanges.forEach((n) => {
    const p = id(n.parentIndex?.guid);
    if (p) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(n);
    }
  });
  for (const [, a] of kids) a.sort((x, y) => (x.parentIndex.position < y.parentIndex.position ? -1 : 1));
  return { m, byId, kids };
}

// ---- matrices ([a b c d e f] as in SVG) ----
const IDENT = [1, 0, 0, 1, 0, 0];
const mul = (A, B) => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];
const inv = (M) => {
  const det = M[0] * M[3] - M[1] * M[2];
  return [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det, (M[2] * M[5] - M[3] * M[4]) / det, (M[1] * M[4] - M[0] * M[5]) / det];
};
const nodeMatrix = (n) => {
  const t = n.transform;
  return t ? [t.m00, t.m10, t.m01, t.m11, t.m02, t.m12] : IDENT;
};
const matStr = (M) => `matrix(${M.map(num).join(' ')})`;
const pt = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];

// ---- path blobs ----
function blobToPath(blobs, idx) {
  const bytes = Uint8Array.from(blobs[idx].bytes.__bytes);
  const dv = new DataView(bytes.buffer);
  let o = 0;
  let d = '';
  const f = () => { const v = dv.getFloat32(o, true); o += 4; return num(v); };
  while (o < bytes.length) {
    const c = bytes[o++];
    if (c === 0) d += 'Z';
    else if (c === 1) d += `M${f()} ${f()}`;
    else if (c === 2) d += `L${f()} ${f()}`;
    else if (c === 3) d += `Q${f()} ${f()} ${f()} ${f()}`;
    else if (c === 4) d += `C${f()} ${f()} ${f()} ${f()} ${f()} ${f()}`;
    else throw new Error('unknown path command ' + c);
  }
  return d;
}

function makeRenderer(doc, imagesDir, opts = {}) {
  const { m, byId, kids } = doc;
  const blobs = m.blobs;
  let uid = 0;
  const defs = [];
  const imageCache = new Map();
  const embedded = new Set();
  const hidden = opts.hide || new Set();

  // Embedded images are re-encoded at a size that still looks sharp at the final 3x render: opaque colour art as
  // high-quality JPEG, masks and transparent art as compact PNG. (The SVG parser rejects very large attributes.)
  const imageDataUri = async (hashHex) => {
    if (imageCache.has(hashHex)) return imageCache.get(hashHex);
    const file = path.join(imagesDir, hashHex);
    const meta = await sharp(file).metadata();
    const max = opts.maxImage || 2000;
    let pipe = sharp(file);
    if (Math.max(meta.width, meta.height) > max) pipe = pipe.resize({ width: meta.width >= meta.height ? max : undefined, height: meta.height > meta.width ? max : undefined });
    const opaqueColour = !meta.hasAlpha; // grayscale masks too: luminance survives JPEG at this quality
    const buf = opaqueColour ? await pipe.jpeg({ quality: 92, mozjpeg: true }).toBuffer() : await pipe.png({ compressionLevel: 9 }).toBuffer();
    const out = { uri: `data:${opaqueColour ? 'image/jpeg' : 'image/png'};base64,${buf.toString('base64')}`, w: meta.width > max || meta.height > max ? (meta.width >= meta.height ? max : Math.round((meta.width * max) / meta.height)) : meta.width, h: meta.width > max || meta.height > max ? (meta.height > meta.width ? max : Math.round((meta.height * max) / meta.width)) : meta.height, origW: meta.width, origH: meta.height };
    imageCache.set(hashHex, out);
    return out;
  };

  const rgb = (c) => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;

  // Fill one geometry path with one paint; returns svg
  async function paintPath(n, d, rule, paint) {
    if (paint.visible === false) return '';
    const op = paint.opacity === undefined ? 1 : paint.opacity;
    if (paint.type === 'SOLID') {
      const a = (paint.color.a === undefined ? 1 : paint.color.a) * op;
      return `<path d="${d}" fill="${rgb(paint.color)}"${a !== 1 ? ` fill-opacity="${num(a)}"` : ''} fill-rule="${rule}"/>`;
    }
    if (paint.type === 'GRADIENT_LINEAR') {
      const T = paint.transform;
      const M = [T.m00, T.m10, T.m01, T.m11, T.m02, T.m12];
      const I = inv(M);
      const w = n.size.x, h = n.size.y;
      const [x1, y1] = pt(I, 0, 0.5);
      const [x2, y2] = pt(I, 1, 0.5);
      const gid = `g${++uid}`;
      const stops = paint.stops.map((s) => `<stop offset="${num(s.position)}" stop-color="${rgb(s.color)}" stop-opacity="${num((s.color.a === undefined ? 1 : s.color.a) * op)}"/>`).join('');
      defs.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${num(x1 * w)}" y1="${num(y1 * h)}" x2="${num(x2 * w)}" y2="${num(y2 * h)}">${stops}</linearGradient>`);
      return `<path d="${d}" fill="url(#${gid})" fill-rule="${rule}"/>`;
    }
    if (paint.type === 'IMAGE') {
      const hash = Buffer.from(paint.image.hash.__bytes).toString('hex');
      const img = await imageDataUri(hash);
      const T = paint.transform || { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
      const M = [T.m00, T.m10, T.m01, T.m11, T.m02, T.m12];
      const w = n.size.x, h = n.size.y;
      // image-normalised -> node-normalised is inv(T); then to node pixels; image element is img.w x img.h px
      const toNode = mul([w, 0, 0, h, 0, 0], mul(inv(M), [1 / img.w, 0, 0, 1 / img.h, 0, 0]));
      const cid = `c${++uid}`;
      defs.push(`<clipPath id="${cid}"><path d="${d}" clip-rule="${rule}"/></clipPath>`);
      // each distinct image is embedded once and referenced, so repeated fills do not repeat the bytes
      if (!embedded.has(hash)) {
        embedded.add(hash);
        defs.push(`<image id="img_${hash.slice(0, 12)}" href="${img.uri}" xlink:href="${img.uri}" width="${img.w}" height="${img.h}" preserveAspectRatio="none"/>`);
      }
      return `<g clip-path="url(#${cid})"${op !== 1 ? ` opacity="${num(op)}"` : ''}><use href="#img_${hash.slice(0, 12)}" xlink:href="#img_${hash.slice(0, 12)}" transform="${matStr(toNode)}"/></g>`;
    }
    return '';
  }

  async function fillsOf(n, geoms, paints) {
    let s = '';
    for (const g of geoms || []) {
      const d = blobToPath(blobs, g.commandsBlob);
      const rule = g.windingRule === 'ODD' ? 'evenodd' : 'nonzero';
      for (const p of paints || []) s += await paintPath(n, d, rule, p);
    }
    return s;
  }

  const isClipping = (n) => n.type === 'FRAME' && n.frameMaskDisabled === false && !n.resizeToFit;

  // outline of a mask node as accumulated paths, in the coordinate space of the mask node's parent
  function outlinePaths(n, M, acc) {
    const M2 = mul(M, nodeMatrix(n));
    const shape = n.type !== 'FRAME' && n.type !== 'TEXT';
    if (n.visible === false) return;
    if (shape && n.fillGeometry) for (const g of n.fillGeometry) acc.push({ d: blobToPath(blobs, g.commandsBlob), rule: g.windingRule === 'ODD' ? 'evenodd' : 'nonzero', M: M2 });
    const ch = kids.get(id(n.guid)) || [];
    if (n.type === 'FRAME' && ch.length === 0 && n.fillGeometry) for (const g of n.fillGeometry) acc.push({ d: blobToPath(blobs, g.commandsBlob), rule: 'nonzero', M: M2 });
    for (const c of ch) outlinePaths(c, M2, acc);
  }

  async function renderChildren(n) {
    let out = '';
    let open = 0;
    for (const c of kids.get(id(n.guid)) || []) {
      if (c.visible === false || hidden.has(id(c.guid))) continue;
      if (c.mask) {
        const mid = `m${++uid}`;
        if (c.maskType === 'LUMINANCE') {
          defs.push(`<mask id="${mid}" mask-type="luminance" maskUnits="userSpaceOnUse" x="-5000" y="-5000" width="10000" height="10000">${await renderNode(c, true)}</mask>`);
          out += `<g mask="url(#${mid})">`;
        } else {
          const acc = [];
          outlinePaths(c, IDENT, acc);
          defs.push(`<clipPath id="${mid}">${acc.map((p) => `<path d="${p.d}" clip-rule="${p.rule}" transform="${matStr(p.M)}"/>`).join('')}</clipPath>`);
          out += `<g clip-path="url(#${mid})">`;
        }
        open++;
        continue;
      }
      out += await renderNode(c);
    }
    return out + '</g>'.repeat(open);
  }

  async function renderNode(n, forMask = false) {
    if (n.type === 'TEXT' || n.type === 'DOCUMENT' || n.type === 'CANVAS') return '';
    if (n.visible === false && !forMask) return '';
    if (hidden.has(id(n.guid))) return '';
    const attrs = [`transform="${matStr(nodeMatrix(n))}"`];
    if (n.opacity !== undefined && n.opacity !== 1) attrs.push(`opacity="${num(n.opacity)}"`);
    let body = '';
    if (n.type === 'FRAME') {
      body += await fillsOf(n, n.fillGeometry, n.fillPaints);
      let inner = await renderChildren(n);
      if (isClipping(n)) {
        const cid = `f${++uid}`;
        const d = n.fillGeometry && n.fillGeometry.length ? blobToPath(blobs, n.fillGeometry[0].commandsBlob) : `M0 0H${num(n.size.x)}V${num(n.size.y)}H0Z`;
        defs.push(`<clipPath id="${cid}"><path d="${d}"/></clipPath>`);
        inner = `<g clip-path="url(#${cid})">${inner}</g>`;
      }
      body += inner;
      if (n.strokeGeometry && n.strokePaints) body += await fillsOf(n, n.strokeGeometry, n.strokePaints);
    } else {
      body += await fillsOf(n, n.fillGeometry, n.fillPaints);
      if (n.strokeGeometry && n.strokePaints) body += await fillsOf(n, n.strokeGeometry, n.strokePaints);
    }
    return `<g ${attrs.join(' ')}>${body}</g>`;
  }

  return {
    usedImages: () => [...imageCache.keys()],
    async frameSvg(frame, scale = 1) {
      const w = frame.size.x, h = frame.size.y;
      // render the frame itself at the origin (ignore its canvas position)
      const clone = { ...frame, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 } };
      const body = await renderNode(clone);
      return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${num(w * scale)}" height="${num(h * scale)}" viewBox="0 0 ${num(w)} ${num(h)}"><defs>${defs.join('')}</defs>${body}</svg>`;
    },
  };
}

module.exports = { load, makeRenderer, id };
