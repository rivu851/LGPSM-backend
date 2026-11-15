"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.recogniseWithTesseract = void 0;
exports.classifyLines = classifyLines;
exports.zonesFromLines = zonesFromLines;
exports.detectTextZones = detectTextZones;
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const sharp_1 = __importDefault(require("sharp"));
const layoutAnalysis_1 = require("./layoutAnalysis");
const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;
const WEEKDAY = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\b/i;
const CLOCK = /\b\d{1,2}\s*[:.]\s*\d{2}\b|\b\d{1,2}\s*(am|pm)\b|\b(am|pm)\b/i;
const YEARISH = /\b(19|20)\d{2}\b/;
const VENUE = /\b\d{6}\b|\b(road|rd|street|st|lane|ln|avenue|ave|near|opp|opposite|hall|club|palace|garden|gardens|park|resort|hotel|tower|floor|plaza|auditorium|banquet|lawn|farm|city|kolkata|delhi|mumbai|chennai|bangalore|bengaluru|hyderabad|pune|india|nagar|colony|sector)\b/i;
// wording the designer printed that stays as it is
// placeholders a designer may have left for the guest's own details
const NAME_PLACEHOLDER = /^(guest|invitee|attendee|visitor|your|dear)?\s*name\b|\b(guest|invitee|attendee)\s+name\b/i;
const META_PLACEHOLDER = /^(company( name)?|designation|organi[sz]ation|additional info(rmation)?)$/i;
const DECORATIVE = /\b(save the date|invitation|invites|invite|you are|you're|welcome|join us|request the|cordially|together with|scan|qr|rsvp|r\.s\.v\.p|and|presents|celebrat|honou?r|pleasure|blessing|with love)\b/i;
const letters = (t) => (t.match(/[a-z]/gi) || []).length;
const isDateLike = (t) => (MONTH.test(t) || WEEKDAY.test(t) || CLOCK.test(t) || (YEARISH.test(t) && /\d/.test(t))) && !VENUE.test(t);
const isVenueLike = (t) => VENUE.test(t) || (/,/.test(t) && /\d/.test(t) && !isDateLike(t));
/** Sorts recognised lines into zones. Pure, so it can be tested without an image. */
function classifyLines(lines, canvas) {
    const good = lines.filter((l) => l.confidence >= 45 && letters(l.text) + (l.text.match(/\d/g) || []).length >= 3 && l.x1 > l.x0 && l.y1 > l.y0);
    const height = (l) => l.y1 - l.y0;
    const nameLine = good.find((l) => NAME_PLACEHOLDER.test(l.text.trim()) && letters(l.text) <= 20);
    const metaLine = good.find((l) => META_PLACEHOLDER.test(l.text.trim()));
    const scan = good.find((l) => /\b(scan|qr)\b/i.test(l.text));
    const dateLines = good.filter((l) => isDateLike(l.text) && l !== nameLine);
    const venueLines = good.filter((l) => !dateLines.includes(l) && l !== nameLine && isVenueLike(l.text));
    // lines of one block sit close together and are centred or aligned alike
    const block = (seed) => {
        if (!seed.length)
            return [];
        const sorted = [...seed].sort((a, b) => a.y0 - b.y0);
        const out = [sorted[0]];
        for (const l of sorted.slice(1)) {
            const last = out[out.length - 1];
            if (l.y0 - last.y1 < 1.6 * Math.max(height(l), height(last)) && Math.abs((l.x0 + l.x1) / 2 - (last.x0 + last.x1) / 2) < 0.2 * canvas.width)
                out.push(l);
        }
        return out;
    };
    const rest = good.filter((l) => !dateLines.includes(l) && !venueLines.includes(l) && l !== nameLine && l !== metaLine && !DECORATIVE.test(l.text) && letters(l.text) >= 3);
    // The title is the tallest line of lettering left over. Script and decorative lettering is often misread (the words come out wrong), but the
    // box around it is still right, so a poorly read line is accepted here as long as it is wide enough to be a heading.
    const wide = (l) => l.x1 - l.x0 >= 0.22 * canvas.width && l.y1 - l.y0 >= 0.018 * canvas.height;
    const loose = lines.filter((l) => l.confidence >= 12 && l.x1 > l.x0 && l.y1 > l.y0 && !dateLines.includes(l) && !venueLines.includes(l) && l !== nameLine && l !== metaLine && l !== scan && !DECORATIVE.test(l.text) && !isDateLike(l.text) && !isVenueLike(l.text) && wide(l) && letters(l.text) >= 2);
    const titleLine = [...rest].sort((a, b) => height(b) - height(a))[0];
    const decorative = good.filter((l) => DECORATIVE.test(l.text) && !/\b(scan|qr)\b/i.test(l.text));
    return { title: titleLine ? [titleLine] : undefined, dateTime: block(dateLines).length ? block(dateLines) : undefined, venue: block(venueLines).length ? block(venueLines) : undefined, inviteeName: nameLine ? [nameLine] : undefined, inviteeMeta: metaLine ? [metaLine] : undefined, scan, decorative, loose };
}
/** The colour of the wording in a box: the pixels that differ most from the picture around it */
async function inkOf(image, box) {
    try {
        const meta = await (0, sharp_1.default)(image).metadata();
        const W = meta.width || 0, H = meta.height || 0;
        const left = Math.max(0, Math.round(box.x)), top = Math.max(0, Math.round(box.y));
        const width = Math.max(1, Math.min(W - left, Math.round(box.w))), height = Math.max(1, Math.min(H - top, Math.round(box.h)));
        const { data } = await (0, sharp_1.default)(image).extract({ left, top, width, height }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const n = width * height;
        // the background colour: the median of the border pixels of the box
        const edgeVals = [];
        for (let x = 0; x < width; x++) {
            edgeVals.push([data[x * 3], data[x * 3 + 1], data[x * 3 + 2]]);
            const b = ((height - 1) * width + x) * 3;
            edgeVals.push([data[b], data[b + 1], data[b + 2]]);
        }
        const med = [0, 1, 2].map((c) => edgeVals.map((v) => v[c]).sort((a, b) => a - b)[Math.floor(edgeVals.length / 2)]);
        const dist = (i) => Math.abs(data[i * 3] - med[0]) + Math.abs(data[i * 3 + 1] - med[1]) + Math.abs(data[i * 3 + 2] - med[2]);
        const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => dist(b) - dist(a)).slice(0, Math.max(1, Math.round(n * 0.04)));
        const rgb = [0, 1, 2].map((c) => Math.round(order.reduce((t, i) => t + data[i * 3 + c], 0) / order.length));
        return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    }
    catch {
        return '#222222';
    }
}
const union = (ls) => ({ x: Math.min(...ls.map((l) => l.x0)), y: Math.min(...ls.map((l) => l.y0)), w: Math.max(...ls.map((l) => l.x1)) - Math.min(...ls.map((l) => l.x0)), h: Math.max(...ls.map((l) => l.y1)) - Math.min(...ls.map((l) => l.y0)) });
async function zonesFromLines(image, lines, canvas) {
    const found = classifyLines(lines, canvas);
    const zones = [];
    const add = async (role, ls, family, weight) => {
        if (!ls?.length)
            return;
        const box = union(ls);
        const pad = Math.min(12, Math.max(4, Math.round(Math.min(...ls.map((l) => l.y1 - l.y0)) * 0.18))); // covers the soft edge of the letters, never more than a little
        const padded = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), w: Math.min(canvas.width, box.w + 2 * pad), h: Math.min(canvas.height, box.h + 2 * pad) };
        const centre = box.x + box.w / 2;
        zones.push({ role, ...padded, lines: ls.length, color: await inkOf(image, box), fontFamily: family, fontWeight: weight, align: Math.abs(centre - canvas.width / 2) < 0.08 * canvas.width ? 'center' : centre < canvas.width / 2 ? 'left' : 'right' });
    };
    const asLine = (b) => ({ text: '', confidence: 100, x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });
    const hint = found.scan ? { x: found.scan.x0, y: found.scan.y0, w: found.scan.x1 - found.scan.x0, h: found.scan.y1 - found.scan.y0 } : undefined;
    const frame = await (0, layoutAnalysis_1.findQrFrame)(image, canvas, hint);
    const nearEdge = (l) => l.y0 < 0.1 * canvas.height || l.y1 > 0.93 * canvas.height || l.x1 - l.x0 > 0.92 * canvas.width;
    // The event name. Read from the picture when the words were read well; otherwise it is script or decorative lettering that text recognition
    // cannot read, and it is found by where it is (under the "Save the date" style line, above the QR box and the date) and by its ink.
    let title = found.title && !nearEdge(found.title[0]) && (await (0, layoutAnalysis_1.looksLikeLettering)(image, canvas, { x: found.title[0].x0, y: found.title[0].y0, w: found.title[0].x1 - found.title[0].x0, h: found.title[0].y1 - found.title[0].y0 })) ? found.title : undefined;
    if (!title) {
        const above = found.decorative.filter((l) => l.y1 < 0.8 * canvas.height).sort((a, b) => b.y1 - a.y1)[0];
        const below = [frame ? frame.y : Infinity, found.scan?.y0 ?? Infinity, found.dateTime?.[0]?.y0 ?? Infinity, found.venue?.[0]?.y0 ?? Infinity].reduce((m, v) => Math.min(m, v), canvas.height);
        if (above && below - above.y1 > 0.04 * canvas.height) {
            const band = await (0, layoutAnalysis_1.inkBand)(image, canvas, above.y1 + 6, below - 6);
            if (band && band.w >= 0.2 * canvas.width)
                title = [asLine(band)];
        }
    }
    if (!title) {
        // the tallest badly-read line that is lettering and not part of the artwork around the edges
        for (const l of [...found.loose].filter((x) => !nearEdge(x)).sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0))) {
            if (await (0, layoutAnalysis_1.looksLikeLettering)(image, canvas, { x: l.x0, y: l.y0, w: l.x1 - l.x0, h: l.y1 - l.y0 })) {
                title = [l];
                break;
            }
        }
    }
    await add('title', title, 'Playfair Display', 700);
    // The date and time. When it sits in a badge or pill that text recognition could not read, it is the band between the QR caption and the venue.
    let dateTime = found.dateTime;
    if (!dateTime && found.venue) {
        const top = Math.max(found.scan?.y1 ?? 0, frame ? frame.y + frame.h : 0);
        if (top > 0 && found.venue[0].y0 - top > 0.04 * canvas.height) {
            const band = await (0, layoutAnalysis_1.inkBand)(image, canvas, top + 8, found.venue[0].y0 - 8);
            if (band)
                dateTime = [asLine(band)];
        }
    }
    await add('dateTime', dateTime, 'Inter', 600);
    await add('venue', found.venue, 'Inter', 500);
    // the guest's own details go only where the design left a place for them (a printed "Guest Name" placeholder): never on top of the artwork
    await add('inviteeName', found.inviteeName, 'Inter', 700);
    await add('inviteeMeta', found.inviteeMeta, 'Inter', 400);
    // the QR code: in the design's own empty QR box when it has one, otherwise on the quietest spot of the picture
    const qrSize = Math.round(0.27 * canvas.width);
    const wording = zones.map((z) => ({ x: z.x, y: z.y, w: z.w, h: z.h }));
    const spot = frame ?? (await (0, layoutAnalysis_1.calmSpot)(image, canvas, qrSize, wording));
    zones.push({ role: 'qr', x: spot.x, y: spot.y, w: spot.w, h: spot.h, lines: 1, color: '#000000', fontFamily: 'Inter', fontWeight: 400, align: 'center', frame: !!frame });
    const hasTitle = zones.some((z) => z.role === 'title');
    const hasMore = zones.some((z) => z.role === 'dateTime' || z.role === 'venue');
    const detected = hasTitle && hasMore;
    // All or nothing: a card with only some of its wording replaced (the venue new, the title still the designer's) is worse than none. When the
    // wording is not found with confidence, nothing is replaced and the areas are marked by hand.
    const kept = detected ? zones : zones.filter((z) => z.role === 'qr' || z.role === 'inviteeName' || z.role === 'inviteeMeta');
    return { detected, zones: kept, reason: !hasTitle ? 'The event name could not be found in the picture.' : !hasMore ? 'Neither the date nor the venue could be found in the picture.' : undefined };
}
/** Text recognition with tesseract.js (English). The language file is fetched once and kept in the temp folder. */
const recogniseWithTesseract = async (png) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createWorker } = require('tesseract.js');
    const worker = await createWorker('eng', 1, { cachePath: path_1.default.join(os_1.default.tmpdir(), 'lgpsm-tesseract'), ...(process.env.TESSDATA_PATH ? { langPath: process.env.TESSDATA_PATH } : {}) });
    try {
        const result = await worker.recognize(png, {}, { blocks: true });
        const lines = [];
        for (const block of result.data.blocks || [])
            for (const para of block.paragraphs)
                for (const l of para.lines) {
                    lines.push({ text: String(l.text || '').replace(/\s+/g, ' ').trim(), confidence: l.confidence, x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1 });
                }
        return lines;
    }
    finally {
        await worker.terminate();
    }
};
exports.recogniseWithTesseract = recogniseWithTesseract;
/** Looks for the title, date and venue wording in an uploaded design (already cropped to the card's canvas). Never throws: failing to read is "not detected". */
async function detectTextZones(image, canvas, recognise = exports.recogniseWithTesseract, timeoutMs = 30_000) {
    try {
        const lines = await Promise.race([recognise(image), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))]);
        return await zonesFromLines(image, lines, canvas);
    }
    catch (err) {
        // the wording could not be read, but the QR code still goes where the design has room for it
        let qr = [];
        try {
            const frame = await (0, layoutAnalysis_1.findQrFrame)(image, canvas);
            const spot = frame ?? (await (0, layoutAnalysis_1.calmSpot)(image, canvas, Math.round(0.27 * canvas.width)));
            qr = [{ role: 'qr', x: spot.x, y: spot.y, w: spot.w, h: spot.h, lines: 1, color: '#000000', fontFamily: 'Inter', fontWeight: 400, align: 'center', frame: !!frame }];
        }
        catch { /* the default place is used */ }
        return { detected: false, zones: qr, reason: `The picture could not be read automatically (${err.message}).` };
    }
}
