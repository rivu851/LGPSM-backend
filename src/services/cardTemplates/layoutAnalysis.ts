import sharp from 'sharp';

/**
 * Reading the layout of an organizer's uploaded design, so the guest's QR code goes where the designer left room for it.
 *  - `findQrFrame`: the design's own empty QR box (a white, roughly square panel, usually with "Scan the QR code" under it).
 *  - `calmSpot`: when the design has no such box, the quietest square of the picture (the least going on in it), away from the wording.
 */
export interface Box { x: number; y: number; w: number; h: number }

const WORK = 4; // the picture is looked at at a quarter of the card's size

async function grey(image: Buffer, canvas: { width: number; height: number }) {
  const w = Math.round(canvas.width / WORK), h = Math.round(canvas.height / WORK);
  const { data } = await sharp(image).resize(w, h, { fit: 'fill' }).flatten({ background: '#ffffff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, w, h };
}

/** A white, roughly square, solid panel: the design's QR frame. `hint` is where the words "Scan the QR code" sit (the frame is just above them). */
export async function findQrFrame(image: Buffer, canvas: { width: number; height: number }, hint?: Box): Promise<Box | null> {
  const { data, w, h } = await grey(image, canvas);
  const white = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) white[i] = data[i] >= 238 ? 1 : 0;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const found: Array<{ box: Box; fill: number }> = [];
  const minSide = 0.12 * w, maxSide = 0.5 * w;
  for (let start = 0; start < w * h; start++) {
    if (!white[start] || seen[start]) continue;
    let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p - x) / w;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && white[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && white[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && white[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && white[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw < minSide || bh < minSide || bw > maxSide || bh > maxSide) continue;
    const aspect = bw / bh;
    if (aspect < 0.8 || aspect > 1.25) continue;
    const fill = count / (bw * bh);
    if (fill < 0.9) continue; // a solid panel (a round photo frame or a ring is not)
    if (minX <= 1 || minY <= 1 || maxX >= w - 2 || maxY >= h - 2) continue; // not the page margin
    found.push({ box: { x: minX, y: minY, w: bw, h: bh }, fill });
  }
  if (!found.length) return null;
  const hintCx = hint ? (hint.x + hint.w / 2) / WORK : null;
  const hintTop = hint ? hint.y / WORK : null;
  found.sort((a, b) => {
    const score = (c: { box: Box; fill: number }) => c.fill - (hintTop !== null ? Math.abs(c.box.y + c.box.h - hintTop) / h + Math.abs(c.box.x + c.box.w / 2 - (hintCx as number)) / w : 0);
    return score(b) - score(a);
  });
  const b = found[0].box;
  const side = Math.min(b.w, b.h);
  // inside the panel's own border, so the code sits inside the frame the designer drew
  const inset = Math.max(1, Math.round(side * 0.04));
  return { x: (b.x + inset) * WORK, y: (b.y + inset) * WORK, w: (side - 2 * inset) * WORK, h: (side - 2 * inset) * WORK };
}

/** The quietest square of the picture for a code of the given size, away from the wording (`avoid`) and the top edge */
export async function calmSpot(image: Buffer, canvas: { width: number; height: number }, size: number, avoid: Box[] = []): Promise<Box> {
  const { data, w, h } = await grey(image, canvas);
  // how much is going on at each pixel: the difference with its neighbours
  const busy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    busy[i] = Math.abs(data[i + 1] - data[i - 1]) + Math.abs(data[i + w] - data[i - w]);
  }
  for (const a of avoid) {
    const x0 = Math.max(0, Math.floor(a.x / WORK)), y0 = Math.max(0, Math.floor(a.y / WORK)), x1 = Math.min(w, Math.ceil((a.x + a.w) / WORK)), y1 = Math.min(h, Math.ceil((a.y + a.h) / WORK));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) busy[y * w + x] += 400; // wording is never covered
  }
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0;
    for (let x = 1; x <= w; x++) { row += busy[(y - 1) * w + (x - 1)]; integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + row; }
  }
  const side = Math.max(8, Math.round(size / WORK));
  let best = { x: Math.round((w - side) / 2), y: h - side - Math.round(0.05 * h), cost: Infinity };
  for (let y = Math.round(0.2 * h); y + side <= h - 2; y += 2) for (let x = 2; x + side <= w - 2; x += 2) {
    const sum = integral[(y + side) * (w + 1) + (x + side)] - integral[y * (w + 1) + (x + side)] - integral[(y + side) * (w + 1) + x] + integral[y * (w + 1) + x];
    // a gentle pull towards the lower middle, where a code is expected
    const cost = sum / (side * side) + 0.4 * (Math.abs(x + side / 2 - w / 2) / w + Math.abs(y + side / 2 - 0.78 * h) / h) * 10;
    if (cost < best.cost) best = { x, y, cost };
  }
  return { x: best.x * WORK, y: best.y * WORK, w: side * WORK, h: side * WORK };
}

/**
 * A band of lettering (or a pill / badge holding lettering) in a stretch of the picture, found from the picture itself rather than from reading
 * the words, so script and decorative lettering that text recognition cannot read is still located. Between `top` and `bottom` (card pixels),
 * the rows where something stands out from the smooth background around it are grouped; the tallest group is returned.
 */
export async function inkBand(image: Buffer, canvas: { width: number; height: number }, top: number, bottom: number): Promise<Box | null> {
  const y0 = Math.max(0, Math.round(top)), y1 = Math.min(canvas.height, Math.round(bottom));
  if (y1 - y0 < 0.02 * canvas.height) return null;
  const k = 2;
  const w = Math.round(canvas.width / k), h = Math.round((y1 - y0) / k);
  // (separate steps: sharp applies only the last resize of a chain, and an extract always acts on the picture as it was)
  const full = await sharp(image).resize(canvas.width, canvas.height, { fit: 'fill' }).png().toBuffer();
  const strip = await sharp(full).extract({ left: 0, top: y0, width: canvas.width, height: y1 - y0 }).png().toBuffer();
  const base = sharp(strip).resize(w, h, { fit: 'fill' }).flatten({ background: '#ffffff' }).greyscale();
  const grey = await base.clone().raw().toBuffer();
  const smooth = await base.clone().blur(14).raw().toBuffer();
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ink[i] = Math.abs(grey[i] - smooth[i]) > 26 ? 1 : 0;
  const left = Math.round(0.06 * w), right = Math.round(0.94 * w);
  const rowInk = new Float32Array(h);
  for (let y = 0; y < h; y++) { let c = 0; for (let x = left; x < right; x++) c += ink[y * w + x]; rowInk[y] = c / (right - left); }
  const bands: Array<[number, number]> = [];
  let start = -1, gap = 0;
  for (let y = 0; y < h; y++) {
    if (rowInk[y] > 0.015) { if (start < 0) start = y; gap = 0; }
    else if (start >= 0 && ++gap > 6) { bands.push([start, y - gap]); start = -1; gap = 0; }
  }
  if (start >= 0) bands.push([start, h - 1]);
  const real = bands.filter(([a, b]) => (b - a + 1) * k >= 0.018 * canvas.height);
  if (!real.length) return null;
  real.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  const [a, b] = real[0];
  let minX = w, maxX = 0;
  for (let y = a; y <= b; y++) for (let x = left; x < right; x++) if (ink[y * w + x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  if (maxX <= minX) return null;
  return { x: minX * k, y: y0 + a * k, w: (maxX - minX + 1) * k, h: (b - a + 1) * k };
}

/** Is a box filled with lettering (a flat ink colour on a smooth background) rather than artwork such as flowers? */
export async function looksLikeLettering(image: Buffer, canvas: { width: number; height: number }, box: Box): Promise<boolean> {
  try {
    const left = Math.max(0, Math.round(box.x)), top = Math.max(0, Math.round(box.y));
    const width = Math.max(2, Math.min(canvas.width - left, Math.round(box.w))), height = Math.max(2, Math.min(canvas.height - top, Math.round(box.h)));
    const full = await sharp(image).resize(canvas.width, canvas.height, { fit: 'fill' }).png().toBuffer();
    const { data } = await sharp(full).extract({ left, top, width, height }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const n = width * height;
    const border: number[][] = [];
    for (let x = 0; x < width; x++) { border.push([data[x * 3], data[x * 3 + 1], data[x * 3 + 2]]); const b = ((height - 1) * width + x) * 3; border.push([data[b], data[b + 1], data[b + 2]]); }
    const med = [0, 1, 2].map((c) => border.map((v) => v[c]).sort((a, b) => a - b)[Math.floor(border.length / 2)]);
    const dist = (i: number) => Math.abs(data[i * 3] - med[0]) + Math.abs(data[i * 3 + 1] - med[1]) + Math.abs(data[i * 3 + 2] - med[2]);
    const far = Array.from({ length: n }, (_, i) => i).sort((a, b) => dist(b) - dist(a)).slice(0, Math.max(1, Math.round(n * 0.03)));
    const ink = [0, 1, 2].map((c) => far.reduce((t, i) => t + data[i * 3 + c], 0) / far.length);
    // every pixel of lettering lies on the line from the background colour to the ink colour (the soft edge of a letter is a mix of the two)
    const d = ink.map((v, c) => v - med[c]);
    const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
    let onLine = 0;
    for (let i = 0; i < n; i++) {
      const v = [data[i * 3] - med[0], data[i * 3 + 1] - med[1], data[i * 3 + 2] - med[2]];
      const t = Math.min(1, Math.max(0, (v[0] * d[0] + v[1] * d[1] + v[2] * d[2]) / len2));
      const off = Math.abs(v[0] - t * d[0]) + Math.abs(v[1] - t * d[1]) + Math.abs(v[2] - t * d[2]);
      if (off < 42) onLine++;
    }
    return onLine / n > 0.88;
  } catch {
    return false;
  }
}
