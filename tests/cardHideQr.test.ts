import sharp from 'sharp';
jest.setTimeout(60_000); // each case renders two full cards; with the whole suite running side by side the 5 s default is not enough
import { renderTemplateCard, sampleTexts, TEMPLATE_DESIGNS } from '../src/services/cardTemplates/renderer';

// "Select data to show on card" with Event QR unticked: the QR's frame is part of each design's artwork, so the band holding
// it is cut out and the content closes up inside the same card size, instead of printing an empty frame or a gap.
describe('cards without the QR', () => {
  it.each(TEMPLATE_DESIGNS)('%s: the frame band is removed and the card keeps its size', async (design) => {
    const full = await sharp(await renderTemplateCard({ design, texts: sampleTexts(design), qr: null, scale: 1 })).metadata();
    const without = await sharp(await renderTemplateCard({ design, texts: sampleTexts(design), qr: null, hideQr: true, scale: 1 })).metadata();
    expect(full.height).toBe(682);
    expect(without.width).toBe(full.width);
    expect(without.height).toBe(full.height); // a phone screen does not shrink: the content is re-centred instead
  });

  it('a card that shows its QR is unchanged', async () => {
    const qr = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#000' } }).png().toBuffer();
    const meta = await sharp(await renderTemplateCard({ design: 'CORPORATE_V1', texts: sampleTexts('CORPORATE_V1'), qr, scale: 1 })).metadata();
    expect(meta.height).toBe(682);
  });
});

// The Add Event phone preview takes whatever the server renders and sizes the phone to it: so a card without its QR must come back
// exactly as big as one with it, for every kind of event.
import { renderTemplatePreview } from '../src/services/cardTemplates/preview';
describe('the Add Event preview with and without the QR', () => {
  const events: Array<[string, { categoryName?: string; subcategoryName?: string; title: string }]> = [
    ['corporate', { categoryName: 'Corporate', subcategoryName: 'Awards & Recognition', title: 'Annual Awards' }],
    ['wedding', { categoryName: 'Social', subcategoryName: 'Wedding', title: 'Moloy & Dola' }],
    ['birthday', { categoryName: 'Social', subcategoryName: 'Birthday', title: 'Srija Turns 7' }],
    ['rice ceremony', { categoryName: 'Social', subcategoryName: 'Rice Ceremony', title: 'Ayanika' }],
    ['general', { title: 'abcd event' }],
  ];
  it.each(events)('%s: the preview keeps the same size when the QR is hidden', async (_n, e) => {
    const base = { ...e, startIso: '2026-11-11T07:30:00Z', endIso: '2026-11-12T07:30:00Z', venue: 'Tollygunge, West Bengal, Kolkata - 700033, India', contactNumber: '1234567890' };
    const withQr = await sharp(await renderTemplatePreview(null, { ...base, cardDisplay: { qr: true } }, true)).metadata();
    const noQr = await sharp(await renderTemplatePreview(null, { ...base, cardDisplay: { qr: false } }, true)).metadata();
    expect(noQr.width).toBe(withQr.width);
    expect(noQr.height).toBe(withQr.height);
  });
});
