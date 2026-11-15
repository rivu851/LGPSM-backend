import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { SPEC_FONTS } from './designSpec';
import { calmSpot, findQrFrame, Box } from './layoutAnalysis';

/**
 * Finding the wording inside an organizer's uploaded design, so the event's own details can replace it in the same place, with the picture
 * left as it is. The picture is read with text recognition; each line found is sorted into the title, the date and time, or the venue
 * (wording such as "Save the date" stays as the designer made it). When the title and one more detail cannot be found with confidence,
 * `detected` is false and the person marks the areas by hand instead.
 */
export type ZoneRole = 'title' | 'dateTime' | 'venue' | 'inviteeName' | 'inviteeMeta' | 'qr';
export interface TextZone {
  role: ZoneRole;
  x: number; y: number; w: number; h: number;
  /** how many lines of the original wording the area covers (the event's text may use up to this many) */
  lines: number;
  color: string;
  fontFamily: (typeof SPEC_FONTS)[number];
  fontWeight: 400 | 500 | 600 | 700;
  align: 'left' | 'center' | 'right';
  /** paint the old wording out of the picture first (default: yes for the event's wording, no for an empty area the person marked) */
  erase?: boolean;
  /** qr only: true when the code sits in the design's own empty QR box (drawn on a white tile like the box); false when it is placed on a calm spot of the picture */
  frame?: boolean;
}
export interface RecognisedLine { text: string; confidence: number; x0: number; y0: number; x1: number; y1: number }
export interface DetectedZones { detected: boolean; zones: TextZone[]; reason?: string }

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

const letters = (t: string) => (t.match(/[a-z]/gi) || []).length;
const isDateLike = (t: string) => (MONTH.test(t) || WEEKDAY.test(t) || CLOCK.test(t) || (YEARISH.test(t) && /\d/.test(t))) && !VENUE.test(t);
const isVenueLike = (t: string) => VENUE.test(t) || (/,/.test(t) && /\d/.test(t) && !isDateLike(t));

/** Sorts recognised lines into zones. Pure, so it can be tested without an image. */
export function classifyLines(lines: RecognisedLine[], canvas: { width: number; height: number }): { title?: RecognisedLine[]; dateTime?: RecognisedLine[]; venue?: RecognisedLine[]; inviteeName?: RecognisedLine[]; inviteeMeta?: RecognisedLine[]; scan?: RecognisedLine } {
  const good = lines.filter((l) => l.confidence >= 45 && letters(l.text) + (l.text.match(/\d/g) || []).length >= 3 && l.x1 > l.x0 && l.y1 > l.y0);
  const height = (l: RecognisedLine) => l.y1 - l.y0;
  const nameLine = good.find((l) => NAME_PLACEHOLDER.test(l.text.trim()) && letters(l.text) <= 20);
  const metaLine = good.find((l) => META_PLACEHOLDER.test(l.text.trim()));
  const scan = good.find((l) => /\b(scan|qr)\b/i.test(l.text));
  const dateLines = good.filter((l) => isDateLike(l.text) && l !== nameLine);
  const venueLines = good.filter((l) => !dateLines.includes(l) && l !== nameLine && isVenueLike(l.text));
  // lines of one block sit close together and are centred or aligned alike
  const block = (seed: RecognisedLine[]): RecognisedLine[] => {
    if (!seed.length) return [];
    const sorted = [...seed].sort((a, b) => a.y0 - b.y0);
    const out = [sorted[0]];
    for (const l of sorted.slice(1)) {
      const last = out[out.length - 1];
      if (l.y0 - last.y1 < 1.6 * Math.max(height(l), height(last)) && Math.abs((l.x0 + l.x1) / 2 - (last.x0 + last.x1) / 2) < 0.2 * canvas.width) out.push(l);
    }
    return out;
  };
  const rest = good.filter((l) => !dateLines.includes(l) && !venueLines.includes(l) && l !== nameLine && l !== metaLine && !DECORATIVE.test(l.text) && letters(l.text) >= 3);
  const titleLine = [...rest].sort((a, b) => height(b) - height(a))[0];
  return { title: titleLine ? [titleLine] : undefined, dateTime: block(dateLines).length ? block(dateLines) : undefined, venue: block(venueLines).length ? block(venueLines) : undefined, inviteeName: nameLine ? [nameLine] : undefined, inviteeMeta: metaLine ? [metaLine] : undefined, scan };
}

/** The colour of the wording in a box: the pixels that differ most from the picture around it */
async function inkOf(image: Buffer, box: { x: number; y: number; w: number; h: number }): Promise<string> {
  try {
    const meta = await sharp(image).metadata();
    const W = meta.width || 0, H = meta.height || 0;
    const left = Math.max(0, Math.round(box.x)), top = Math.max(0, Math.round(box.y));
    const width = Math.max(1, Math.min(W - left, Math.round(box.w))), height = Math.max(1, Math.min(H - top, Math.round(box.h)));
    const { data } = await sharp(image).extract({ left, top, width, height }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const n = width * height;
    // the background colour: the median of the border pixels of the box
    const edgeVals: number[][] = [];
    for (let x = 0; x < width; x++) { edgeVals.push([data[x * 3], data[x * 3 + 1], data[x * 3 + 2]]); const b = ((height - 1) * width + x) * 3; edgeVals.push([data[b], data[b + 1], data[b + 2]]); }
    const med = [0, 1, 2].map((c) => edgeVals.map((v) => v[c]).sort((a, b) => a - b)[Math.floor(edgeVals.length / 2)]);
    const dist = (i: number) => Math.abs(data[i * 3] - med[0]) + Math.abs(data[i * 3 + 1] - med[1]) + Math.abs(data[i * 3 + 2] - med[2]);
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => dist(b) - dist(a)).slice(0, Math.max(1, Math.round(n * 0.04)));
    const rgb = [0, 1, 2].map((c) => Math.round(order.reduce((t, i) => t + data[i * 3 + c], 0) / order.length));
    return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return '#222222';
  }
}

const union = (ls: RecognisedLine[]) => ({ x: Math.min(...ls.map((l) => l.x0)), y: Math.min(...ls.map((l) => l.y0)), w: Math.max(...ls.map((l) => l.x1)) - Math.min(...ls.map((l) => l.x0)), h: Math.max(...ls.map((l) => l.y1)) - Math.min(...ls.map((l) => l.y0)) });

export async function zonesFromLines(image: Buffer, lines: RecognisedLine[], canvas: { width: number; height: number }): Promise<DetectedZones> {
  const found = classifyLines(lines, canvas);
  const zones: TextZone[] = [];
  const add = async (role: ZoneRole, ls: RecognisedLine[] | undefined, family: TextZone['fontFamily'], weight: TextZone['fontWeight']) => {
    if (!ls?.length) return;
    const box = union(ls);
    const pad = Math.max(4, Math.round(Math.min(...ls.map((l) => l.y1 - l.y0)) * 0.18)); // covers the soft edge of the letters
    const padded = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), w: Math.min(canvas.width, box.w + 2 * pad), h: Math.min(canvas.height, box.h + 2 * pad) };
    const centre = box.x + box.w / 2;
    zones.push({ role, ...padded, lines: ls.length, color: await inkOf(image, box), fontFamily: family, fontWeight: weight, align: Math.abs(centre - canvas.width / 2) < 0.08 * canvas.width ? 'center' : centre < canvas.width / 2 ? 'left' : 'right' });
  };
  await add('title', found.title, 'Playfair Display', 700);
  await add('dateTime', found.dateTime, 'Inter', 600);
  await add('venue', found.venue, 'Inter', 500);
  // the guest's own details go only where the design left a place for them (a printed "Guest Name" placeholder): never on top of the artwork
  await add('inviteeName', found.inviteeName, 'Inter', 700);
  await add('inviteeMeta', found.inviteeMeta, 'Inter', 400);
  // the QR code: in the design's own empty QR box when it has one, otherwise on the quietest spot of the picture
  const qrSize = Math.round(0.27 * canvas.width);
  const hint: Box | undefined = found.scan ? { x: found.scan.x0, y: found.scan.y0, w: found.scan.x1 - found.scan.x0, h: found.scan.y1 - found.scan.y0 } : undefined;
  const frame = await findQrFrame(image, canvas, hint);
  const wording = zones.map((z) => ({ x: z.x, y: z.y, w: z.w, h: z.h }));
  const spot = frame ?? (await calmSpot(image, canvas, qrSize, wording));
  zones.push({ role: 'qr', x: spot.x, y: spot.y, w: spot.w, h: spot.h, lines: 1, color: '#000000', fontFamily: 'Inter', fontWeight: 400, align: 'center', frame: !!frame });
  const hasTitle = zones.some((z) => z.role === 'title');
  const hasMore = zones.some((z) => z.role === 'dateTime' || z.role === 'venue');
  return { detected: hasTitle && hasMore, zones, reason: !hasTitle ? 'The event name could not be found in the picture.' : !hasMore ? 'Neither the date nor the venue could be found in the picture.' : undefined };
}

type Recogniser = (png: Buffer) => Promise<RecognisedLine[]>;

/** Text recognition with tesseract.js (English). The language file is fetched once and kept in the temp folder. */
export const recogniseWithTesseract: Recogniser = async (png) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker('eng', 1, { cachePath: path.join(os.tmpdir(), 'lgpsm-tesseract'), ...(process.env.TESSDATA_PATH ? { langPath: process.env.TESSDATA_PATH } : {}) });
  try {
    const result = await worker.recognize(png, {}, { blocks: true });
    const lines: RecognisedLine[] = [];
    for (const block of result.data.blocks || []) for (const para of block.paragraphs) for (const l of para.lines) {
      lines.push({ text: String(l.text || '').replace(/\s+/g, ' ').trim(), confidence: l.confidence, x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1 });
    }
    return lines;
  } finally {
    await worker.terminate();
  }
};

/** Looks for the title, date and venue wording in an uploaded design (already cropped to the card's canvas). Never throws: failing to read is "not detected". */
export async function detectTextZones(image: Buffer, canvas: { width: number; height: number }, recognise: Recogniser = recogniseWithTesseract, timeoutMs = 30_000): Promise<DetectedZones> {
  try {
    const lines = await Promise.race([recognise(image), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))]);
    return await zonesFromLines(image, lines, canvas);
  } catch (err) {
    // the wording could not be read, but the QR code still goes where the design has room for it
    let qr: TextZone[] = [];
    try {
      const frame = await findQrFrame(image, canvas);
      const spot = frame ?? (await calmSpot(image, canvas, Math.round(0.27 * canvas.width)));
      qr = [{ role: 'qr', x: spot.x, y: spot.y, w: spot.w, h: spot.h, lines: 1, color: '#000000', fontFamily: 'Inter', fontWeight: 400, align: 'center', frame: !!frame }];
    } catch { /* the default place is used */ }
    return { detected: false, zones: qr, reason: `The picture could not be read automatically (${(err as Error).message}).` };
  }
}
