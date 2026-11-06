import sharp from 'sharp';
import { renderTemplateCard, sampleTexts, TEMPLATE_DESIGNS } from '../src/services/cardTemplates/renderer';

// "Select data to show on card" with Event QR unticked: the QR's frame is part of each design's artwork, so the band holding
// it is cut out and the card closes up, instead of printing an empty frame with a gap.
describe('cards without the QR', () => {
  it.each(TEMPLATE_DESIGNS)('%s: the frame band is removed and the card gets shorter', async (design) => {
    const full = await sharp(await renderTemplateCard({ design, texts: sampleTexts(design), qr: null, scale: 1 })).metadata();
    const without = await sharp(await renderTemplateCard({ design, texts: sampleTexts(design), qr: null, hideQr: true, scale: 1 })).metadata();
    expect(full.height).toBe(682);
    expect(without.width).toBe(full.width);
    expect(without.height!).toBeLessThan(560);
    expect(without.height!).toBeGreaterThan(400);
  });

  it('a card that shows its QR is unchanged', async () => {
    const qr = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#000' } }).png().toBuffer();
    const meta = await sharp(await renderTemplateCard({ design: 'CORPORATE_V1', texts: sampleTexts('CORPORATE_V1'), qr, scale: 1 })).metadata();
    expect(meta.height).toBe(682);
  });
});
