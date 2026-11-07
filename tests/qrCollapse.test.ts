import fs from 'fs';
import path from 'path';
import { convertStitchDesign } from '../src/services/stitch/stitch.converter';
import { CANVAS_PRESETS, DesignSpec, SpecElement } from '../src/services/cardTemplates/designSpec';
import { qrCollapsePlan } from '../src/services/cardTemplates/qrCollapse';

jest.setTimeout(60_000); // each case converts and lays out a full design (image work): the 5 s default is too tight when the whole suite runs side by side

// Custom designs printed without the QR: the QR, its frame and its "scan" caption come out and the layout closes up, but only when
// that is safe. Otherwise only the QR group is removed.
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
async function gala(preset: keyof typeof CANVAS_PRESETS): Promise<DesignSpec> {
  const r = await convertStitchDesign({ html: fixture('stitch-gala.html').toString('utf8'), screenshot: fixture('stitch-gala.png'), kind: CANVAS_PRESETS[preset].kind, preset });
  if (!r.ready || !r.spec) throw new Error('fixture did not convert');
  return r.spec;
}
const box = (e: SpecElement) => e.type === 'line' ? { t: Math.min(e.y1, e.y2), b: Math.max(e.y1, e.y2) } : e.type === 'qr' ? { t: e.y, b: e.y + e.size } : { t: e.y, b: e.y + (e as any).h };
const isText = (e: SpecElement) => e.type === 'text';

describe('custom card designs without the QR', () => {
  it.each(['INVITATION_PORTRAIT', 'INVITATION_CARD', 'INVITATION_SQUARE'] as const)('%s: the QR group is removed and the content is re-centred in the same canvas', async (preset) => {
    const spec = await gala(preset);
    const plan = qrCollapsePlan(spec);
    expect(plan.elements.some((e) => e.type === 'qr')).toBe(false);
    expect(plan.elements.some((e) => e.type === 'text' && e.role === 'label' && /scan/i.test(String(e.label)))).toBe(false);
    expect(plan.shift).toBeGreaterThan(100);
    expect(plan.height).toBe(spec.canvas.height); // the card keeps its size
    // everything still fits the canvas
    for (const e of plan.elements) { expect(box(e).t).toBeGreaterThanOrEqual(-1); expect(box(e).b).toBeLessThanOrEqual(plan.height + 1); }
    // the remaining content sits centred: better than merely deleting the QR and leaving everything where it was
    const keptBefore = spec.elements.filter((e) => plan.elements.some((k) => k.type === e.type && (k as any).role === (e as any).role && (k as any).label === (e as any).label));
    const textsOf = (els: SpecElement[]) => els.filter(isText).map(box);
    const imbalance = (els: SpecElement[]) => Math.abs(Math.min(...textsOf(els).map((t) => t.t)) - (spec.canvas.height - Math.max(...textsOf(els).map((t) => t.b))));
    expect(imbalance(plan.elements)).toBeLessThan(imbalance(keptBefore));
    expect(imbalance(plan.elements)).toBeLessThan(spec.canvas.height * 0.15);
    // borders and panels around the card are untouched
    const edges = (els: SpecElement[]) => els.filter((e) => (e.type === 'rect' && box(e).b - box(e).t > spec.canvas.height * 0.7)).map(box);
    expect(edges(plan.elements)).toEqual(edges(spec.elements));
    // closing up adds no overlaps between texts (the generated design may already have some of its own)
    const overlapsIn = (els: SpecElement[]) => { const t = textsOf(els); let n = 0; for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) if (t[i].t < t[j].b - 1 && t[j].t < t[i].b - 1) n++; return n; };
    expect(overlapsIn(plan.elements)).toBeLessThanOrEqual(overlapsIn(keptBefore));
  });

  it('leaves the layout alone when something sits beside the QR', async () => {
    const spec = await gala('INVITATION_CARD');
    const qr: any = spec.elements.find((e) => e.type === 'qr');
    const beside: SpecElement = { type: 'text', role: 'inviteeMeta', x: 20, y: qr.y + 20, w: 300, h: 40, align: 'left', valign: 'top', fontFamily: 'Inter', fontWeight: 400, size: 24, lineHeight: 1.2, letterSpacing: 0, uppercase: false, maxLines: 1, color: '#FFFFFF', opacity: 1 } as any;
    const plan = qrCollapsePlan({ ...spec, elements: [...spec.elements, beside] });
    expect(plan.shift).toBe(0);
    expect(plan.height).toBe(spec.canvas.height);
    expect(plan.elements.some((e) => e.type === 'qr')).toBe(false);
    expect(plan.elements).toContain(beside);
  });

  it("never re-lays out an organizer's uploaded artwork", async () => {
    const spec = await gala('INVITATION_CARD');
    const plan = qrCollapsePlan({ ...spec, backgroundMedia: 'media:0123456789abcdef01234567' });
    expect(plan.shift).toBe(0);
    expect(plan.elements.some((e) => e.type === 'qr')).toBe(false);
  });
});
