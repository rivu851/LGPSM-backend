import sharp from 'sharp';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { resolveCardDesign, DEFAULT_CARD_DESIGN } from '../src/services/cardTemplates/designs';
import { buildTemplateTexts, deriveSubject, initialsOf, longDate, ordinal, shortDateRange } from '../src/services/cardTemplates/content';
import { renderTemplateCard, sampleTexts, TEMPLATE_DESIGNS, cardLayout, isTemplateDesign } from '../src/services/cardTemplates/renderer';
import { cardAssetsAvailable, assetPath } from '../src/utils/assetPath';
import { loadCardContext } from '../src/services/cardTemplates/context';
import { invitationService } from '../src/services/invitation.service';
import { invitationCardService } from '../src/services/invitationCard.service';
import { Category } from '../src/models/Category';
import { Template } from '../src/models/Template';
import { Event } from '../src/models/Event';

jest.setTimeout(120000);

describe('which design an event gets', () => {
  it("uses the organizer's chosen template whatever the event type is", () => {
    expect(resolveCardDesign({ templateDesign: 'WEDDING', subcategoryName: 'Birthday' })).toBe('WEDDING');
    expect(resolveCardDesign({ templateDesign: 'CLASSIC', subcategoryName: 'Birthday' })).toBe('CLASSIC');
  });

  it.each([
    [{ subcategoryName: 'Birthday' }, 'BIRTHDAY'],
    [{ subcategoryName: "Child's B'day Party" }, 'BIRTHDAY'],
    [{ subcategoryName: 'Rice Ceremony' }, 'RICE_CEREMONY'],
    [{ subcategoryName: 'Annaprasan' }, 'RICE_CEREMONY'],
    [{ subcategoryName: 'Wedding Reception' }, 'WEDDING'],
    [{ categoryName: 'Wedding' }, 'WEDDING'],
    [{ subcategoryName: 'Engagement' }, 'WEDDING'],
    [{ subcategoryName: 'Awards & Recognition' }, 'CORPORATE_V1'],
    [{ categoryName: 'Corporate', subcategoryName: 'Leadership Summit' }, 'CORPORATE_V2'],
    [{ categoryName: 'Technology' }, 'CORPORATE_V2'],
    [{ categoryName: 'General' }, 'CORPORATE_V2']
  ])('maps %j to %s', (type, expected) => {
    expect(resolveCardDesign(type)).toBe(expected);
  });

  it('prefers the specific type over words that merely appear in the title', () => {
    expect(resolveCardDesign({ subcategoryName: 'Rice Ceremony', title: 'Ria Birthday and Rice' })).toBe('RICE_CEREMONY');
  });

  it('falls back to the title, then to a safe default', () => {
    expect(resolveCardDesign({ categoryName: 'General', title: "Riya's Birthday!!" })).toBe('BIRTHDAY');
    expect(resolveCardDesign({ categoryName: 'General', title: 'Team meetup' })).toBe(DEFAULT_CARD_DESIGN);
    expect(resolveCardDesign({})).toBe(DEFAULT_CARD_DESIGN);
  });

  it('ignores a design name it does not know', () => {
    expect(resolveCardDesign({ templateDesign: 'SPACESHIP', subcategoryName: 'Birthday' })).toBe('BIRTHDAY');
  });
});

describe('card wording', () => {
  const when = { startIso: '2026-11-02T10:00:00+05:30', endIso: '2026-11-05T18:00:00+05:30' };

  it('formats ordinals and date ranges in the platform time zone', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']);
    expect(shortDateRange(new Date(when.startIso), new Date(when.endIso))).toBe('2nd - 5th Nov 2026');
    expect(shortDateRange(new Date('2026-10-30T10:00:00+05:30'), new Date('2026-11-02T10:00:00+05:30'))).toBe('30th Oct to 2nd Nov 2026');
    expect(shortDateRange(new Date(when.startIso), null)).toBe('2nd Nov 2026');
    expect(shortDateRange(new Date('2026-12-30T10:00:00+05:30'), new Date('2027-01-02T10:00:00+05:30'))).toBe('30th Dec 2026 to 2nd Jan 2027');
    expect(longDate(new Date(when.startIso), new Date(when.endIso))).toBe('2nd - 5th November, 2026');
    expect(longDate(new Date(when.startIso), new Date('2026-12-05T10:00:00+05:30'))).toBe('2nd Nov - 5th Dec, 2026');
    expect(longDate(new Date(when.startIso), null)).toBe('2nd November, 2026');
  });

  it('finds the guest of honour in a title', () => {
    expect(deriveSubject('Moloy Birthday Celebration!!!', ['birthday', 'celebration', 'party'])).toBe('Moloy');
    expect(deriveSubject("Srija's 10th Birthday Party", ['birthday', 'party'])).toBe("Srija's 10th");
    expect(deriveSubject('Moloy Roy & Dola Kar Wedding Reception', ['wedding', 'reception'])).toBe('Moloy Roy & Dola Kar');
    expect(deriveSubject('Birthday Party', ['birthday', 'party'])).toBe('Birthday Party'); // nothing left: keep the title
    expect(deriveSubject('Partyman Birthday', ['birthday', 'party'])).toBe('Partyman'); // whole words only
  });

  it('builds initials from names in any script', () => {
    expect(initialsOf('Moloy Roy & Dola Kar')).toBe('MR');
    expect(initialsOf('শ্রীজা ভট্টাচার্য')).toBe('শভ');
    expect(initialsOf('')).toBe('');
  });

  it('writes a birthday card for a birthday', () => {
    const t = buildTemplateTexts({ design: 'BIRTHDAY', title: 'Moloy Birthday Celebration!!!', subcategoryName: 'Birthday', venue: '24, Shanti Pally', locationSub: 'Kolkata', ...when });
    expect(t).toMatchObject({ intro: 'Please Join us to celebrate', honoree: 'Moloy', heading: 'Birthday Party', month: 'November 2026', weekday: 'Monday', day: '02', time: 'At 10:00 AM', address: '24, Shanti Pally, Kolkata' });
  });

  it('keeps "Birthday Party" unless the subcategory is more specific', () => {
    const heading = (subcategoryName: string) => buildTemplateTexts({ design: 'BIRTHDAY', title: 'Riya Birthday', subcategoryName }).heading;
    expect(heading('Birthday')).toBe('Birthday Party');
    expect(heading('First Birthday')).toBe('First Birthday');
    expect(heading('')).toBe('Birthday Party');
  });

  it('writes wedding wording that fits the kind of wedding event', () => {
    const base = { design: 'WEDDING' as const, title: 'Anik & Riya', ...when };
    expect(buildTemplateTexts({ ...base, subcategoryName: 'Wedding' }).subline).toBe('are getting married');
    expect(buildTemplateTexts({ ...base, subcategoryName: 'Wedding Reception' }).subline).toBe('invite you to their wedding reception');
    expect(buildTemplateTexts({ ...base, subcategoryName: 'Engagement' }).subline).toBe('are getting engaged');
    expect(buildTemplateTexts({ ...base, subcategoryName: 'Wedding' })).toMatchObject({ names: 'Anik & Riya', timeLine: 'Monday, 10:00 AM', day: '02', month: '11', year: '26' });
  });

  it('writes a rice ceremony card', () => {
    const t = buildTemplateTexts({ design: 'RICE_CEREMONY', title: 'Ayanika Rice Ceremony', ...when });
    expect(t).toMatchObject({ heading: 'Rice Ceremony', subline: 'of our beloved child', honoree: 'Ayanika', timeLine: 'Monday, 10:00 am', day: '02', month: '11', year: '26' });
  });

  it("personalises corporate cards with the guest's details", () => {
    const v1 = buildTemplateTexts({ design: 'CORPORATE_V1', title: 'Excellence Awards', invitee: { name: 'Mr. Harsh', employeeId: '51470A', companyName: 'Acme' }, venue: 'Hall 3', ...when });
    expect(v1).toMatchObject({ title: 'Excellence Awards', inviteeName: 'Mr. Harsh', inviteeMeta: 'Employee ID #51470A', datePill: 'Event Dates: 2nd - 5th November, 2026', address: 'Hall 3' });
    const v2 = buildTemplateTexts({ design: 'CORPORATE_V2', title: 'Leadership Summit', invitee: { name: 'Subhendu', companyName: 'XYZ Ltd' }, venue: 'Salt Lake Stadium, Sector V, Kolkata', ...when });
    expect(v2).toMatchObject({ inviteeName: 'Subhendu', inviteeMeta: 'XYZ Ltd', datePill: '2nd - 5th Nov 2026', address: 'Sector V, Kolkata' });
  });

  it('says "Online event" for a virtual event and leaves missing details empty instead of inventing them', () => {
    expect(buildTemplateTexts({ design: 'CORPORATE_V2', title: 'Webinar', isVirtual: true, venue: 'https://zoom.example' }).address).toBe('Online event');
    const bare = buildTemplateTexts({ design: 'BIRTHDAY', title: 'Riya Birthday' });
    expect(bare).toMatchObject({ month: '', weekday: '', day: '', time: '', address: '' });
  });
});

describe('card artwork and fonts ship with the app', () => {
  it('are found from the code location', () => {
    expect(cardAssetsAvailable()).toBe(true);
    for (const design of TEMPLATE_DESIGNS) expect(assetPath('cardTemplates', cardLayout(design).background)).toMatch(/background\.png$/);
  });
});

describe('rendering', () => {
  const size = async (png: Buffer) => {
    const m = await sharp(png).metadata();
    return [m.width, m.height];
  };
  const pixels = async (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  it.each([...TEMPLATE_DESIGNS])('%s renders a card at the designers\' proportions', async (design) => {
    const png = await renderTemplateCard({ design, texts: sampleTexts(design) });
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const layout = cardLayout(design);
    expect(await size(png)).toEqual([layout.width * 2, layout.height * 2]);
    expect(isTemplateDesign(design)).toBe(true);
  });

  it('puts text exactly where the designers put it, and nowhere else', async () => {
    const blank = await pixels(await renderTemplateCard({ design: 'BIRTHDAY', texts: {} }));
    const named = await pixels(await renderTemplateCard({ design: 'BIRTHDAY', texts: { honoree: 'Srija' } }));
    const slot = cardLayout('BIRTHDAY').texts.honoree;
    const S = 2;
    const w = blank.info.width;
    let inside = 0;
    let outside = 0;
    for (let y = 0; y < blank.info.height; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (blank.data[i] === named.data[i] && blank.data[i + 1] === named.data[i + 1] && blank.data[i + 2] === named.data[i + 2]) continue;
        const withinSlot = y >= (slot.top - 10) * S && y <= (slot.top + slot.lineHeight + 20) * S && Math.abs(x - slot.cx * S) <= (slot.boxWidth / 2 + 20) * S;
        if (withinSlot) inside++;
        else outside++;
      }
    }
    expect(inside).toBeGreaterThan(500); // the name is drawn
    expect(outside).toBe(0); // and nothing else changed
  });

  it('keeps an over-long title inside the card margins', async () => {
    const title = 'The Annual Global Leadership and Innovation Excellence Summit for Senior Executives of the Southern Region 2026';
    const blank = await pixels(await renderTemplateCard({ design: 'CORPORATE_V2', texts: {} }));
    const long = await pixels(await renderTemplateCard({ design: 'CORPORATE_V2', texts: { title } }));
    const w = blank.info.width;
    const margin = 20 * 2;
    for (let y = 0; y < blank.info.height; y++) {
      for (const x of [...Array(margin).keys(), ...Array.from({ length: margin }, (_, k) => w - 1 - k)]) {
        const i = (y * w + x) * 4;
        expect([long.data[i], long.data[i + 1], long.data[i + 2]]).toEqual([blank.data[i], blank.data[i + 1], blank.data[i + 2]]);
      }
    }
  });

  it('draws Bengali and Devanagari names with the right glyphs (no empty boxes)', async () => {
    const latin = await renderTemplateCard({ design: 'BIRTHDAY', texts: { honoree: 'Srija' } });
    const bengali = await renderTemplateCard({ design: 'BIRTHDAY', texts: { honoree: 'শ্রীজা ভট্টাচার্য' } });
    const hindi = await renderTemplateCard({ design: 'BIRTHDAY', texts: { honoree: 'श्रीजा भट्टाचार्य' } });
    expect(bengali.equals(latin)).toBe(false);
    expect(hindi.equals(latin)).toBe(false);
    expect(bengali.equals(hindi)).toBe(false);
  });

  it('uses the organizer photo in the designers\' frame when there is one', async () => {
    const photo = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#ff0000' } }).jpeg().toBuffer();
    const without = await pixels(await renderTemplateCard({ design: 'WEDDING', texts: {} }));
    const withPhoto = await pixels(await renderTemplateCard({ design: 'WEDDING', texts: {}, photo }));
    const p = cardLayout('WEDDING').photo!;
    const cx = Math.round((p.x + p.w / 2) * 2);
    const cy = Math.round((p.y + p.h / 2) * 2);
    const at = (px: typeof without, x: number, y: number) => Array.from(px.data.subarray((y * px.info.width + x) * 4, (y * px.info.width + x) * 4 + 3));
    const isRed = ([r, g, b]: number[]) => r > 240 && g < 15 && b < 15; // JPEG compression nudges the exact value
    expect(isRed(at(withPhoto, cx, cy))).toBe(true); // the photo fills the middle of the frame
    expect(isRed(at(without, cx, cy))).toBe(false); // the neutral placeholder otherwise
    // the circular frame: a corner of the photo's bounding box stays clear of the photo
    expect(isRed(at(withPhoto, Math.round(p.x * 2) + 2, Math.round(p.y * 2) + 2))).toBe(false);
  });

  it('survives an unreadable photo or logo by falling back, not failing the whole card', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const png = await renderTemplateCard({ design: 'CORPORATE_V1', texts: { title: 'Awards' }, photo: Buffer.from('not an image'), logo: Buffer.from('nope') });
    warn.mockRestore();
    expect(png.subarray(1, 4).toString()).toBe('PNG');
  });

  it('refuses a design that does not exist', async () => {
    await expect(renderTemplateCard({ design: 'NOPE' as never, texts: {} })).rejects.toThrow(/Unknown card design/);
  });

  it('is deterministic for the same input and different for different guests', async () => {
    const a = await renderTemplateCard({ design: 'CORPORATE_V1', texts: { inviteeName: 'Asha Rao' } });
    const b = await renderTemplateCard({ design: 'CORPORATE_V1', texts: { inviteeName: 'Asha Rao' } });
    const c = await renderTemplateCard({ design: 'CORPORATE_V1', texts: { inviteeName: 'Vikram Sen' } });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });
});

describe("the designers' sample photos are for previews only", () => {
  const frameCentre = async (design: 'WEDDING' | 'BIRTHDAY' | 'RICE_CEREMONY', png: Buffer) => {
    const p = cardLayout(design).photo!;
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const x = Math.round((p.x + p.w / 2) * 2);
    const y = Math.round((p.y + p.h / 2) * 2);
    return Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3));
  };

  it.each(['WEDDING', 'BIRTHDAY', 'RICE_CEREMONY'] as const)('%s shows the sample photo only when asked, and ships it with the app', async (design) => {
    expect(cardLayout(design).samplePhoto).toMatch(/^samples\/.*\.jpg$/);
    expect(assetPath('cardTemplates', cardLayout(design).samplePhoto!)).toMatch(/\.jpg$/);
    const placeholder = await renderTemplateCard({ design, texts: {}, initials: 'AB' });
    const sample = await renderTemplateCard({ design, texts: {}, useSamplePhoto: true });
    expect(sample.equals(placeholder)).toBe(false);
    // the sample photo is a real photograph: the frame is not a flat fill like the placeholder
    expect(await frameCentre(design, sample)).not.toEqual(await frameCentre(design, placeholder));
  });

  it('an uploaded photo always wins over the sample', async () => {
    const photo = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#00ff00' } }).jpeg().toBuffer();
    const png = await renderTemplateCard({ design: 'BIRTHDAY', texts: {}, photo, useSamplePhoto: true });
    const [r, g, b] = await frameCentre('BIRTHDAY', png);
    expect(g).toBeGreaterThan(200);
    expect(r).toBeLessThan(40);
    expect(b).toBeLessThan(40);
  });

  it('a card that is sent never carries the sample photo; a preview does until an image is uploaded', async () => {
    const base = { invitee: { name: 'A' }, event: { title: 'Riya Birthday' }, sessions: [], cardDesign: 'BIRTHDAY' as const };
    const sent = await invitationCardService.generateInvitationCardPNG(base);
    const preview = await invitationCardService.generateInvitationCardPNG({ ...base, isPreview: true });
    const placeholderCard = await renderTemplateCard({ design: 'BIRTHDAY', texts: buildTemplateTexts({ design: 'BIRTHDAY', title: 'Riya Birthday', invitee: { name: 'A' } }), initials: 'R' });
    expect(preview.equals(sent)).toBe(false);
    expect(await frameCentre('BIRTHDAY', sent)).toEqual(await frameCentre('BIRTHDAY', placeholderCard));
  });
});

describe('end to end: an event with no template still gets a card for its type', () => {
  let mongoServer: MongoMemoryServer;
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('chooses the birthday design from the event category and renders it', async () => {
    const category = await Category.create({ name: 'Personal', isActive: true, subcategories: [{ name: 'Birthday' }, { name: 'Wedding' }] });
    const organizerId = new mongoose.Types.ObjectId();
    const event = await Event.create({
      organizerId, title: 'Moloy Birthday Celebration!!!', description: 'd', format: 'PHYSICAL' as never,
      categoryId: category._id, subcategoryId: (category as any).subcategories[0]._id,
      location: { address: '24, Shanti Pally' } as never, schedule: { start: new Date('2026-11-02T10:00:00+05:30'), end: new Date('2026-11-02T14:00:00+05:30') }
    });

    const ctx = await loadCardContext(event);
    expect(ctx).toMatchObject({ cardDesign: 'BIRTHDAY', categoryName: 'Personal', subcategoryName: 'Birthday' });

    const { png, qr } = await invitationService.previewInvitationCard(String(event._id), String(organizerId));
    expect(qr).toBe('SAMPLE');
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([786, 1364]);
  });

  it("honours an explicit template's design over the event type", async () => {
    const category = await Category.create({ name: 'Anything', isActive: true });
    const template = await Template.create({ name: 'Mine', cardDesign: 'WEDDING' });
    const event = await Event.create({
      organizerId: new mongoose.Types.ObjectId(), title: 'Birthday bash', description: 'd', format: 'PHYSICAL' as never,
      categoryId: category._id, templateId: template._id, schedule: { start: new Date(), end: new Date() }
    });
    expect((await loadCardContext(event)).cardDesign).toBe('WEDDING');
  });

  it('keeps the generic design when a template asks for it', async () => {
    const svgSpy = jest.spyOn(invitationCardService, 'generateInvitationCardSVG');
    const png = await invitationCardService.generateInvitationCardPNG({ invitee: { name: 'A' }, event: { title: 'T' }, sessions: [], cardDesign: 'CLASSIC' });
    expect(svgSpy).toHaveBeenCalled();
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    svgSpy.mockRestore();
  });
});

describe('fitting stays fast on awkward input', () => {
  it('handles a title of many short words and a single huge word quickly', async () => {
    const manyWords = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    const hugeWord = 'Pneumonoultramicroscopicsilicovolcanoconiosis'.repeat(3);
    for (const title of [manyWords, hugeWord, '    ', 'A']) {
      const started = Date.now();
      const png = await renderTemplateCard({ design: 'CORPORATE_V1', texts: { title, inviteeName: title, address: title } });
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(Date.now() - started).toBeLessThan(5000);
    }
  });
});

describe('date line next to the calendar icon', () => {
  // The Corporate card prints a calendar icon at the left end of its date pill (it ends about x=66 of 393); a long date once ran into it.
  it.each([
    ['one day', '2026-10-28T23:00:00+05:30'],
    ['days of one month', '2026-10-29T23:00:00+05:30'],
    ['across months', '2026-11-02T23:00:00+05:30'],
  ])('keeps the text clear of the icon (%s)', async (_label, endIso) => {
    const texts = buildTemplateTexts({ design: 'CORPORATE_V2', title: 'Launch', startIso: '2026-10-28T19:00:00+05:30', endIso, invitee: { name: 'Guest' } } as any);
    const png = await renderTemplateCard({ design: 'CORPORATE_V2', texts });
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const scale = info.width / 393;
    const pill = (x: number, y: number) => { const i = (Math.round(y * scale) * info.width + Math.round(x * scale)) * 4; return [data[i], data[i + 1], data[i + 2]]; };
    const base = pill(348, 575); // the pill's plain colour, right of any text
    // between the icon (ends ~66) and where the text may start (~83) the pill must still be its plain colour on every row of the band
    for (let y = 562; y < 590; y += 2) {
      for (let x = 70; x < 80; x++) {
        const p = pill(x, y);
        expect(Math.abs(p[0] - base[0]) + Math.abs(p[1] - base[1]) + Math.abs(p[2] - base[2])).toBeLessThan(40);
      }
    }
  });
});
