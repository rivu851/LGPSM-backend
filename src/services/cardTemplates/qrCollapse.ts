import type { DesignSpec, SpecElement } from './designSpec';

/**
 * A custom design printed without its QR ("Select data to show on card" with Event QR unticked). Removing only the QR element
 * would leave an empty space (and any frame drawn around the code), so the whole QR group comes out and the layout closes up:
 *  - the group is the QR, any rectangle / ellipse drawn as its frame (it encloses the code and is not much larger), and the
 *    "scan" caption next to it;
 *  - everything that starts below the group moves up, so the next element sits as far below what was above the QR as the QR
 *    itself did; panels and borders that run around the whole card get shorter by the same amount, and so does the canvas;
 *  - thin lines that start beside the group (the legs of corner brackets, say) move up with the rest, as long as they then
 *    touch nothing that stayed put.
 * The layout is only changed when that is safe: if text, an image or a shape sits beside the QR, or a moved element would
 * overlap one that stayed, only the QR group is removed. An organizer's uploaded artwork is never re-laid out (this code
 * cannot see what the picture prints around the QR).
 */
export interface QrCollapsePlan {
  /** the design's elements without the QR group, moved up when the layout closes */
  elements: SpecElement[];
  /** the canvas height after closing up (unchanged when the layout is left as it is) */
  height: number;
  /** how far the layout moved up; 0 when it was left as it is */
  shift: number;
}

interface Box { top: number; bottom: number; left: number; right: number }

function boxOf(e: SpecElement): Box {
  switch (e.type) {
    case 'qr': return { top: e.y, bottom: e.y + e.size, left: e.x, right: e.x + e.size };
    case 'line': return { top: Math.min(e.y1, e.y2), bottom: Math.max(e.y1, e.y2), left: Math.min(e.x1, e.x2), right: Math.max(e.x1, e.x2) };
    default: return { top: e.y, bottom: e.y + e.h, left: e.x, right: e.x + e.w };
  }
}
const overlaps = (a: Box, b: Box) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const isScanCaption = (e: SpecElement) => e.type === 'text' && e.role === 'label' && /scan/i.test(String(e.label || ''));

function moved(e: SpecElement, d: number): SpecElement {
  if (e.type === 'line') return { ...e, y1: e.y1 - d, y2: e.y2 - d };
  return { ...e, y: (e as any).y - d } as SpecElement;
}
function shortened(e: SpecElement, d: number): SpecElement {
  if (e.type === 'rect' || e.type === 'ellipse' || e.type === 'image') return { ...e, h: e.h - d } as SpecElement;
  if (e.type === 'line') return e.y1 >= e.y2 ? { ...e, y1: e.y1 - d } : { ...e, y2: e.y2 - d };
  return e;
}

export function qrCollapsePlan(spec: Pick<DesignSpec, 'canvas' | 'elements' | 'backgroundMedia'>): QrCollapsePlan {
  const height = spec.canvas.height;
  const qr = spec.elements.find((e) => e.type === 'qr');
  if (!qr || qr.type !== 'qr') return { elements: spec.elements.filter((e) => !isScanCaption(e)), height, shift: 0 };
  const q = boxOf(qr);
  const near = (b: Box) => b.top < q.bottom + qr.size * 0.6 && b.bottom > q.top - qr.size * 0.6;

  const group = new Set<SpecElement>([qr]);
  for (const e of spec.elements) {
    if (e === qr) continue;
    const b = boxOf(e);
    // a frame: encloses the code and is at most about twice its size
    const encloses = (e.type === 'rect' || e.type === 'ellipse') && b.left <= q.left + 1 && b.top <= q.top + 1 && b.right >= q.right - 1 && b.bottom >= q.bottom - 1;
    if (encloses && b.right - b.left <= qr.size * 2.2 && b.bottom - b.top <= qr.size * 2.2) group.add(e);
    else if (isScanCaption(e) && near(b)) group.add(e);
  }
  const kept = spec.elements.filter((e) => !group.has(e) && !isScanCaption(e));
  const asIs = { elements: kept, height, shift: 0 };
  if (spec.backgroundMedia) return asIs;

  const g = [...group].map(boxOf);
  const groupTop = Math.min(...g.map((b) => b.top));
  const groupBottom = Math.max(...g.map((b) => b.bottom));

  // sort every kept element: above the group, around it (panels / borders spanning it), or starting beside / below it
  type Kind = 'above' | 'spans' | 'moves';
  const kinds = new Map<SpecElement, Kind>();
  for (const e of kept) {
    const b = boxOf(e);
    if (b.bottom <= groupTop + 0.5) kinds.set(e, 'above');
    else if (b.top < groupTop - 0.5 && b.bottom >= q.bottom - 0.5) kinds.set(e, 'spans'); // a panel / border around the code
    else if (b.top >= groupBottom - 0.5) kinds.set(e, 'moves');
    else if (e.type === 'line' && b.top >= groupTop - 0.5) kinds.set(e, 'moves'); // a thin line that starts beside the QR
    else return asIs; // something sits beside the QR (or reaches into it from above): leave the layout alone
  }
  const above = kept.filter((e) => kinds.get(e) === 'above').map(boxOf);
  const movers = kept.filter((e) => kinds.get(e) === 'moves').map(boxOf);
  const aboveBottom = above.length ? Math.max(...above.map((b) => b.bottom)) : 0;
  // the first thing that moves (the next element below, or a line that started beside the QR) lands where the group started
  const nextBelow = movers.length ? Math.min(...movers.map((b) => b.top)) : height;
  const d = Math.round((nextBelow - groupTop) * 100) / 100;
  if (d < 8) return asIs;
  // a panel or border around the card may only lose space below what stays above the QR
  if (kept.some((e) => kinds.get(e) === 'spans' && boxOf(e).bottom - d < aboveBottom + 4)) return asIs;

  const elements = kept.map((e) => (kinds.get(e) === 'moves' ? moved(e, d) : kinds.get(e) === 'spans' ? shortened(e, d) : e));
  // nothing that moved may now overlap something that stayed (panels around the card excepted)
  const stayed = elements.filter((e, i) => kinds.get(kept[i]) === 'above').map(boxOf);
  const movedBoxes = elements.filter((e, i) => kinds.get(kept[i]) === 'moves').map(boxOf);
  if (movedBoxes.some((m) => stayed.some((s) => overlaps(m, s)))) return asIs;
  return { elements, height: Math.round(height - d), shift: d };
}
