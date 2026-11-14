import crypto from 'crypto';
import sharp from 'sharp';
import { renderTemplatePreview } from '../src/services/cardTemplates/preview';
jest.setTimeout(120_000);

// The sixth checkbox of "Select data to show on card": the event logo / picture
const events: Array<[string, { categoryName?: string; subcategoryName?: string; title: string }]> = [
  ['corporate', { categoryName: 'Corporate', subcategoryName: 'Awards & Recognition', title: 'Annual Awards' }],
  ['birthday', { categoryName: 'Social', subcategoryName: 'Birthday Party', title: 'Riya Birthday Party' }],
  ['general', { title: 'abcd event' }],
];
const hash = async (b: Buffer) => crypto.createHash('sha1').update(await sharp(b).raw().toBuffer()).digest('hex');

describe('event logo checkbox', () => {
  it.each(events)('%s: turning the logo off changes the card and nothing else moves', async (_n, e) => {
    const base = { ...e, startIso: '2030-11-11T07:30:00Z', endIso: '2030-11-12T07:30:00Z', venue: 'Kolkata', contactNumber: '1234567890' };
    const on = { title: true, qr: true, dateTime: true, location: true, inviteeName: true, logo: true };
    const a = await renderTemplatePreview(null, { ...base, cardDisplay: on }, true);
    const b = await renderTemplatePreview(null, { ...base, cardDisplay: { ...on, logo: false } }, true);
    expect(await hash(a)).not.toBe(await hash(b));
    const [ma, mb] = await Promise.all([sharp(a).metadata(), sharp(b).metadata()]);
    expect([mb.width, mb.height]).toEqual([ma.width, ma.height]); // the card keeps its size
  });
});
