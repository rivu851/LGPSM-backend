import crypto from 'crypto';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { renderMasterCard, MASTER_SAMPLE } from '../src/services/cardTemplates/masterCard';
import { invitationCardService } from '../src/services/invitationCard.service';
import { masterDateTime } from '../src/services/cardTemplates/content';

jest.setTimeout(120_000);

const hash = async (b: Buffer) => crypto.createHash('sha1').update(await sharp(b).raw().toBuffer()).digest('hex');

describe('the master card', () => {
  let qr: Buffer;
  beforeAll(async () => { qr = await QRCode.toBuffer('https://lgpsm.example/x', { margin: 2, width: 300 }); });

  it('is always 393 x 682 (786 x 1364 at the delivered scale), however much it has to say', async () => {
    for (const input of [
      { ...MASTER_SAMPLE, qr, useSampleLogo: true },
      { ...MASTER_SAMPLE, qr: null },
      { title: 'Only a title' },
      { ...MASTER_SAMPLE, qr, useSampleLogo: true, title: 'A very long event title that goes on and on across several lines of the card'.repeat(2), location: 'A very long venue name, '.repeat(8) }
    ]) {
      const meta = await sharp(await renderMasterCard(input)).metadata();
      expect([meta.width, meta.height]).toEqual([786, 1364]);
    }
  });

  it('closes the column up around whatever is switched off: each detail changes the card', async () => {
    const full = { ...MASTER_SAMPLE, qr, useSampleLogo: true };
    const seen = new Set([await hash(await renderMasterCard(full))]);
    for (const off of [{ useSampleLogo: false }, { qr: null }, { primary: '', secondary: '' }, { title: '' }, { dateTime: '' }]) {
      seen.add(await hash(await renderMasterCard({ ...full, ...off })));
    }
    expect(seen.size).toBe(6);
  });

  it('draws the guest QR code in a white box (the box is empty on a card without one)', async () => {
    const withQr = await sharp(await renderMasterCard({ ...MASTER_SAMPLE, qr, scale: 1 })).raw().toBuffer({ resolveWithObject: true });
    const dark = (b: { data: Buffer; info: { width: number; channels: number } }) => { let n = 0; for (let i = 0; i < b.data.length; i += b.info.channels) if (b.data[i] < 40 && b.data[i + 1] < 40 && b.data[i + 2] < 40) n++; return n; };
    const without = await sharp(await renderMasterCard({ ...MASTER_SAMPLE, qr: null, scale: 1 })).raw().toBuffer({ resolveWithObject: true });
    expect(dark(withQr)).toBeGreaterThan(dark(without) + 500);
  });

  it('is what an event gets as a card: nothing is added under it, the location is always printed, and the QR follows the checkbox', async () => {
    const data = {
      invitee: { name: 'Guest One', companyName: 'PWT' },
      event: { title: 'Gala', venue: 'Grand Ballroom', startIso: '2030-12-31T08:30:00Z', endIso: '2031-01-01T10:30:00Z' },
      sessions: [], invitationUrl: 'https://lgpsm.example/i/x', cardDesign: 'MASTER' as const
    };
    const withQr = await invitationCardService.generateInvitationCardPNG(data);
    expect((await sharp(withQr).metadata()).height).toBe(1364);
    const noQr = await invitationCardService.generateInvitationCardPNG({ ...data, cardDisplay: { qr: false } });
    const noLocationFlag = await invitationCardService.generateInvitationCardPNG({ ...data, cardDisplay: { location: false } });
    expect(await hash(noQr)).not.toBe(await hash(withQr));
    expect(await hash(noLocationFlag)).toBe(await hash(withQr));
  });

  it('writes the date the way the design shows it', () => {
    expect(masterDateTime('2026-12-31T08:30:00Z', '2027-01-01T10:30:00Z')).toBe('Thu 31 Dec 2026 2:00 PM – Fri 1 Jan 2027 4:00 PM');
    expect(masterDateTime('2026-12-31T08:30:00Z', '2026-12-31T10:30:00Z')).toBe('Thu 31 Dec 2026 2:00 PM – 4:00 PM');
    expect(masterDateTime(null, null)).toBe('');
  });
});
