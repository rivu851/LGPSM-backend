import sharp from 'sharp';
import QRCode from 'qrcode';
import { renderTemplateCard, sampleTexts, cardLayout } from '../src/services/cardTemplates/renderer';
import { LAYOUTS } from '../src/services/cardTemplates/layoutOverrides';

jest.setTimeout(60_000);

const LONG: Record<string, string> = {
  title: 'The International Conference on Sustainable Urban Mobility 2026',
  names: 'Aishwarya Chattopadhyay & Venkatakrishnan Subramaniam',
  honoree: 'Aishwarya Chattopadhyay Venkatakrishnan',
  heading: 'Annual Leadership & Innovation Summit',
  subline: 'are delighted to invite you to celebrate the occasion with us',
  address: 'The Grand Convention Centre, Block EP & GP, Sector V, Salt Lake Electronics Complex, Kolkata 700091, West Bengal',
  inviteeName: 'Dr. Subhendu Bhattacharya-Mukherjee',
  inviteeMeta: 'Senior Vice President, Global Partnerships and Strategic Alliances · Employee ID 4521',
  intro: 'You are warmly invited to join us for a day of fun',
};

describe('invitation cards stay inside their design for long content', () => {
  let qr: Buffer;
  beforeAll(async () => { qr = await QRCode.toBuffer('https://example.com/i/abc', { errorCorrectionLevel: 'H', margin: 4, width: 480 }); });

  for (const design of Object.keys(LAYOUTS)) {
    for (const [label, repeat] of [['realistic maximum', 1], ['extreme', 5]] as const) {
      it(`${design}: renders at the design's size with ${label} content, and the QR code is not painted over`, async () => {
        const base = sampleTexts(design as any);
        const texts = Object.fromEntries(Object.keys(base).map((k) => [k, LONG[k] ? (LONG[k] + ' ').repeat(repeat).trim() : base[k]]));
        const withQr = await renderTemplateCard({ design: design as any, texts, qr } as any);
        const layout = cardLayout(design as any);
        const meta = await sharp(withQr).metadata();
        expect(meta.width! / meta.height!).toBeCloseTo(layout.width / layout.height, 2);

        // the QR region must be identical to the same card rendered with only the sample text: long text never covers it
        const sample = await renderTemplateCard({ design: design as any, texts: base, qr } as any);
        if (layout.qr) {
          const scale = meta.width! / layout.width;
          const region = { left: Math.round(layout.qr.x * scale), top: Math.round(layout.qr.y * scale), width: Math.round(layout.qr.size * scale), height: Math.round(layout.qr.size * scale) };
          const [a, b] = await Promise.all([sharp(withQr).extract(region).raw().toBuffer(), sharp(sample).extract(region).raw().toBuffer()]);
          expect(a.equals(b)).toBe(true);
        }
      });
    }
  }
});
