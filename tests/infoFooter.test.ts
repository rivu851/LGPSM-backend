import sharp from 'sharp';
import { appendInfoFooter } from '../src/services/cardTemplates/infoFooter';

const base = () => sharp({ create: { width: 786, height: 1364, channels: 3, background: '#ffffff' } }).png().toBuffer();
const style = { ink: '#202020', accent: '#6B5B3E' };

describe('card info footer', () => {
  it('leaves the card untouched when there is nothing to add', async () => {
    const png = await base();
    expect(await appendInfoFooter(png, [], style)).toBe(png);
    expect(await appendInfoFooter(png, [{ kind: 'name', text: '  ' }, { kind: 'contact', text: '' }], style)).toBe(png);
  });

  it('extends the card downward and keeps the artwork width', async () => {
    const out = await sharp(await appendInfoFooter(await base(), [{ kind: 'contact', text: '+91 9007000891' }], style)).metadata();
    expect(out.width).toBe(786);
    expect(out.height).toBeGreaterThan(1364);
  });

  it('grows with the number of lines', async () => {
    const one = await sharp(await appendInfoFooter(await base(), [{ kind: 'contact', text: '123' }], style)).metadata();
    const three = await sharp(await appendInfoFooter(await base(), [{ kind: 'name', text: 'A' }, { kind: 'meta', text: 'B' }, { kind: 'contact', text: '123' }], style)).metadata();
    expect(three.height!).toBeGreaterThan(one.height!);
  });

  it('copes with very long text without widening the card', async () => {
    const long = 'x'.repeat(400);
    const out = await sharp(await appendInfoFooter(await base(), [{ kind: 'when', text: long }, { kind: 'name', text: long }, { kind: 'contact', text: long }], style)).metadata();
    expect(out.width).toBe(786);
    expect(out.height!).toBeLessThan(1364 + 400);
  });
});

import { contactForCard, coverageOfDesign, coverageOfSpec, detailRows, whenText } from '../src/services/cardTemplates/coverage';
const ev = { title: 'Summit', startIso: '2026-11-05T05:30:00Z', endIso: '2026-11-19T09:30:00Z', venue: 'Hall 1, Kolkata', contactNumber: '123', guestName: 'Guest', guestMeta: 'Acme' };
describe('coverage: only what the artwork lacks is added', () => {
  it('a design with nothing printed gets everything, in reading order', () => {
    const none = { title: false, date: false, time: false, endTime: false, location: false, guest: false, meta: false };
    expect(detailRows(ev, none).map((r) => r.kind)).toEqual(['title', 'when', 'where', 'name', 'meta', 'contact']);
  });
  it('a design that prints title, place and guest only gets the contact line plus the missing end', () => {
    const kinds = detailRows(ev, coverageOfDesign('WEDDING')).map((r) => r.kind);
    expect(kinds).toEqual(['when', 'name', 'meta', 'contact']);
    expect(whenText(ev, coverageOfDesign('WEDDING'))).toBe('Ends Thursday, 19th November 2026, 3:00 PM');
  });
  it('same-day events are fully covered by the designs that hold a time range', () => {
    expect(whenText({ ...ev, endIso: '2026-11-05T09:30:00Z' }, coverageOfDesign('BIRTHDAY'))).toBe('');
    expect(whenText({ ...ev, endIso: '2026-11-05T09:30:00Z' }, coverageOfDesign('CORPORATE_V1'))).toBe('Thursday, 5th November 2026 · 11:00 AM – 3:00 PM');
  });
  it('an uploaded picture gets dates, place and guest, but not a second title', () => {
    const spec = { meta: { generator: 'UPLOAD' }, elements: [{ type: 'text', role: 'inviteeName' }] } as never;
    const kinds = detailRows(ev, coverageOfSpec(spec)).map((r) => r.kind);
    expect(kinds).toEqual(['when', 'where', 'meta', 'contact']);
  });
  it('writes the full dates when the artwork has no date at all', () => {
    const none = { title: true, date: false, time: false, endTime: false, location: true, guest: true, meta: true };
    expect(whenText(ev, none)).toBe('Thu, 5 Nov 2026, 11:00 AM – Thu, 19 Nov 2026, 3:00 PM');
  });
});

import { insertGuestBand } from '../src/services/cardTemplates/infoFooter';
describe('guest band inside the artwork', () => {
  const art = () => sharp({ create: { width: 786, height: 1364, channels: 3, background: '#fffaf0' } }).png().toBuffer();
  it('opens a band for the name, keeping the whole card', async () => {
    const out = await sharp(await insertGuestBand(await art(), 'WEDDING', 'Invitee Name', 'Acme', { ink: '#202020', accent: '#6B5B3E' })).metadata();
    expect(out.width).toBe(786);
    expect(out.height!).toBeGreaterThan(1364);
  });
  it('a second line on its own still goes inside the card', async () => {
    const out = await sharp(await insertGuestBand(await art(), 'WEDDING', '', 'Acme Pvt Ltd', { ink: '#202020', accent: '#6B5B3E' })).metadata();
    expect(out.height!).toBeGreaterThan(1364);
  });
  it('leaves the card alone with no name, or a design without a place to cut', async () => {
    const png = await art();
    expect(await insertGuestBand(png, 'WEDDING', '  ', '', { ink: '#000', accent: '#000' })).toBe(png);
    expect(await insertGuestBand(png, 'CORPORATE_V1', 'Name', undefined, { ink: '#000', accent: '#000' })).toBe(png);
  });
});

describe('the contact number on the card', () => {
  it('carries the +91 the form shows', () => {
    expect(contactForCard('9007000891')).toBe('+91 90070 00891');
    expect(contactForCard('09007000891')).toBe('+91 90070 00891');
    expect(contactForCard('919007000891')).toBe('+91 90070 00891');
    expect(contactForCard(' 90070 00891 ')).toBe('+91 90070 00891');
    expect(contactForCard('123456789')).toBe('+91 123456789');
  });
  it('leaves a number typed with its own country code as typed, and nothing stays nothing', () => {
    expect(contactForCard('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(contactForCard('')).toBe('');
    expect(contactForCard(undefined)).toBe('');
    expect(contactForCard('  ')).toBe('');
  });
  it('is what the footer row prints', () => {
    const rows = detailRows({ contactNumber: '9007000891' }, coverageOfDesign('CLASSIC'));
    expect(rows).toEqual([{ kind: 'contact', text: '+91 90070 00891' }]);
  });
});
