"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findQrFrame = findQrFrame;
exports.calmSpot = calmSpot;
const sharp_1 = __importDefault(require("sharp"));
const WORK = 4; // the picture is looked at at a quarter of the card's size
async function grey(image, canvas) {
    const w = Math.round(canvas.width / WORK), h = Math.round(canvas.height / WORK);
    const { data } = await (0, sharp_1.default)(image).resize(w, h, { fit: 'fill' }).flatten({ background: '#ffffff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    return { data, w, h };
}
/** A white, roughly square, solid panel: the design's QR frame. `hint` is where the words "Scan the QR code" sit (the frame is just above them). */
async function findQrFrame(image, canvas, hint) {
    const { data, w, h } = await grey(image, canvas);
    const white = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++)
        white[i] = data[i] >= 238 ? 1 : 0;
    const seen = new Uint8Array(w * h);
    const stack = [];
    const found = [];
    const minSide = 0.12 * w, maxSide = 0.5 * w;
    for (let start = 0; start < w * h; start++) {
        if (!white[start] || seen[start])
            continue;
        let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
        stack.push(start);
        seen[start] = 1;
        while (stack.length) {
            const p = stack.pop();
            const x = p % w, y = (p - x) / w;
            count++;
            if (x < minX)
                minX = x;
            if (x > maxX)
                maxX = x;
            if (y < minY)
                minY = y;
            if (y > maxY)
                maxY = y;
            if (x > 0 && white[p - 1] && !seen[p - 1]) {
                seen[p - 1] = 1;
                stack.push(p - 1);
            }
            if (x < w - 1 && white[p + 1] && !seen[p + 1]) {
                seen[p + 1] = 1;
                stack.push(p + 1);
            }
            if (y > 0 && white[p - w] && !seen[p - w]) {
                seen[p - w] = 1;
                stack.push(p - w);
            }
            if (y < h - 1 && white[p + w] && !seen[p + w]) {
                seen[p + w] = 1;
                stack.push(p + w);
            }
        }
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        if (bw < minSide || bh < minSide || bw > maxSide || bh > maxSide)
            continue;
        const aspect = bw / bh;
        if (aspect < 0.8 || aspect > 1.25)
            continue;
        const fill = count / (bw * bh);
        if (fill < 0.9)
            continue; // a solid panel (a round photo frame or a ring is not)
        if (minX <= 1 || minY <= 1 || maxX >= w - 2 || maxY >= h - 2)
            continue; // not the page margin
        found.push({ box: { x: minX, y: minY, w: bw, h: bh }, fill });
    }
    if (!found.length)
        return null;
    const hintCx = hint ? (hint.x + hint.w / 2) / WORK : null;
    const hintTop = hint ? hint.y / WORK : null;
    found.sort((a, b) => {
        const score = (c) => c.fill - (hintTop !== null ? Math.abs(c.box.y + c.box.h - hintTop) / h + Math.abs(c.box.x + c.box.w / 2 - hintCx) / w : 0);
        return score(b) - score(a);
    });
    const b = found[0].box;
    const side = Math.min(b.w, b.h);
    // inside the panel's own border, so the code sits inside the frame the designer drew
    const inset = Math.max(1, Math.round(side * 0.04));
    return { x: (b.x + inset) * WORK, y: (b.y + inset) * WORK, w: (side - 2 * inset) * WORK, h: (side - 2 * inset) * WORK };
}
/** The quietest square of the picture for a code of the given size, away from the wording (`avoid`) and the top edge */
async function calmSpot(image, canvas, size, avoid = []) {
    const { data, w, h } = await grey(image, canvas);
    // how much is going on at each pixel: the difference with its neighbours
    const busy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            busy[i] = Math.abs(data[i + 1] - data[i - 1]) + Math.abs(data[i + w] - data[i - w]);
        }
    for (const a of avoid) {
        const x0 = Math.max(0, Math.floor(a.x / WORK)), y0 = Math.max(0, Math.floor(a.y / WORK)), x1 = Math.min(w, Math.ceil((a.x + a.w) / WORK)), y1 = Math.min(h, Math.ceil((a.y + a.h) / WORK));
        for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++)
                busy[y * w + x] += 400; // wording is never covered
    }
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 1; y <= h; y++) {
        let row = 0;
        for (let x = 1; x <= w; x++) {
            row += busy[(y - 1) * w + (x - 1)];
            integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + row;
        }
    }
    const side = Math.max(8, Math.round(size / WORK));
    let best = { x: Math.round((w - side) / 2), y: h - side - Math.round(0.05 * h), cost: Infinity };
    for (let y = Math.round(0.2 * h); y + side <= h - 2; y += 2)
        for (let x = 2; x + side <= w - 2; x += 2) {
            const sum = integral[(y + side) * (w + 1) + (x + side)] - integral[y * (w + 1) + (x + side)] - integral[(y + side) * (w + 1) + x] + integral[y * (w + 1) + x];
            // a gentle pull towards the lower middle, where a code is expected
            const cost = sum / (side * side) + 0.4 * (Math.abs(x + side / 2 - w / 2) / w + Math.abs(y + side / 2 - 0.78 * h) / h) * 10;
            if (cost < best.cost)
                best = { x, y, cost };
        }
    return { x: best.x * WORK, y: best.y * WORK, w: side * WORK, h: side * WORK };
}
