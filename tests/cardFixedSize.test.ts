import sharp from 'sharp';
import { renderTemplatePreview } from '../src/services/cardTemplates/preview';
jest.setTimeout(240_000);

// The template's artwork keeps one size: including or leaving out any detail never changes the size of the card.
const designs: Array<[string, { categoryName?: string; subcategoryName?: string; title: string }]> = [
  ['corporate', { categoryName: 'Corporate', subcategoryName: 'Awards & Recognition', title: 'Annual Awards' }],
  ['wedding', { categoryName: 'Social', subcategoryName: 'Wedding', title: 'Moloy & Dola' }],
  ['birthday', { categoryName: 'Social', subcategoryName: 'Birthday Party', title: 'Riya Birthday Party' }],
  ['general', { title: 'abcd event' }],
];
const sizeOf = async (b: Buffer) => { const m = await sharp(b).metadata(); return `${m.width}x${m.height}`; };

describe('the card keeps its size whatever details are included', () => {
  it.each(designs)('%s', async (_n, e) => {
    const base = { ...e, startIso: '2030-11-11T07:30:00Z', endIso: '2030-11-12T07:30:00Z', venue: 'Tollygunge, West Bengal, Kolkata - 700033, India', contactNumber: '1234567890' };
    const on = { title: true, qr: true, dateTime: true, location: true, inviteeName: true };
    const off = { title: false, qr: false, dateTime: false, location: false, inviteeName: false };
    const sizes = new Set<string>();
    sizes.add(await sizeOf(await renderTemplatePreview(null, { ...base, cardDisplay: on }, true)));
    sizes.add(await sizeOf(await renderTemplatePreview(null, { ...base, cardDisplay: off }, true)));
    sizes.add(await sizeOf(await renderTemplatePreview(null, { ...base, cardDisplay: { ...on, inviteeName: false } }, true)));
    sizes.add(await sizeOf(await renderTemplatePreview(null, { ...base, cardDisplay: { ...on, dateTime: false, location: false } }, true)));
    sizes.add(await sizeOf(await renderTemplatePreview(null, { ...base, contactNumber: '', cardDisplay: on }, true))); // contact not typed yet
    sizes.add(await sizeOf(await renderTemplatePreview(null, { ...base, cardInfo: { primary: 'COMPANY_NAME', secondary: null } as any, cardDisplay: on }, true)));
    expect([...sizes]).toHaveLength(1);
  });
});
