import crypto from 'crypto';
import sharp from 'sharp';
import { renderTemplatePreview } from '../src/services/cardTemplates/preview';
jest.setTimeout(120_000);

// "Select data to show on card": each checkbox must change what the Add Event preview draws, in every kind of event. (The event location is mandatory on
// the master card, so it is not a choice.)
const events: Array<[string, { categoryName?: string; subcategoryName?: string; title: string }]> = [
  ['corporate', { categoryName: 'Corporate', subcategoryName: 'Awards & Recognition', title: 'Annual Awards' }],
  ['wedding', { categoryName: 'Social', subcategoryName: 'Wedding', title: 'Moloy & Dola' }],
  ['general', { title: 'abcd event' }],
];
const hash = async (b: Buffer) => crypto.createHash('sha1').update(await sharp(b).raw().toBuffer()).digest('hex');
const FLAGS = ['title', 'qr', 'dateTime', 'inviteeName'] as const;

describe('card display checkboxes in the preview', () => {
  beforeAll(() => { process.env.MASTER_CARD_ONLY = 'true'; });
  afterAll(() => { delete process.env.MASTER_CARD_ONLY; });

  it.each(events)('%s: each of the checkboxes changes the card', async (_n, e) => {
    const base = { ...e, startIso: '2030-11-11T07:30:00Z', endIso: '2030-11-12T07:30:00Z', venue: 'Tollygunge, West Bengal, Kolkata - 700033, India', contactNumber: '1234567890', cardInfo: { primary: 'COMPANY_NAME', secondary: null } as any };
    const all = { title: true, qr: true, dateTime: true, location: true, inviteeName: true };
    const full = await hash(await renderTemplatePreview(null, { ...base, cardDisplay: all }, true));
    const seen = new Set([full]);
    for (const flag of FLAGS) {
      const h = await hash(await renderTemplatePreview(null, { ...base, cardDisplay: { ...all, [flag]: false } }, true));
      expect([flag, h === full]).toEqual([flag, false]); // unticking it changes the picture
      seen.add(h);
    }
    expect(seen.size).toBe(5); // and each box changes it differently
    // the location is always printed
    expect(await hash(await renderTemplatePreview(null, { ...base, cardDisplay: { ...all, location: false } }, true))).toBe(full);
  });
});
