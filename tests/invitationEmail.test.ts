import { buildInvitationEmail, invitationEmailSubject, whenSentence } from '../src/services/email/invitationEmail';

const base = {
  eventTitle: 'Annual Leadership Summit 2026', inviteeName: 'Sayan Ghosh', invitationUrl: 'https://lgpsm.example/invitation/abc',
  qrCid: 'qr-1', cardCid: 'card-1', organizerLogoCid: 'logo-1', organizerName: 'Iconic Events',
  startIso: '2026-11-21T13:30:00Z', endIso: '2026-11-21T16:30:00Z', venue: 'Taj Bengal', locationSub: 'Kolkata', contactNumber: '9007000891',
};

describe('the invitation email', () => {
  it('is laid out like a Google notice: white page, headline, blue note, rounded details panel and an oval button', () => {
    const html = buildInvitationEmail({ ...base, inviteeEmail: 'sayan@example.com', dietaryPreference: 'Vegetarian' });
    expect(html).toContain('<body style="margin:0;padding:0;background:#FFFFFF;">');
    expect(html).toContain("You're invited to Annual Leadership Summit 2026</h1>");
    expect(html).toContain('sayan@example.com');
    expect(html).toContain('Dear <strong style="font-weight:700;color:#1F1F1F;">Sayan Ghosh</strong>');
    expect(html).toContain('Iconic Events</strong> is delighted to invite you to');
    expect(html).toContain('background:#D3E3FD;border-radius:16px'); // the blue note
    expect(html).toContain('background:#F8FAFD;border-radius:24px'); // the details panel
    expect(html).toContain('border-radius:100px'); // the oval button
    expect(html).toContain('Saturday, 21 November 2026');
    expect(html).toContain('7:00 PM to 10:00 PM');
    expect(html).toContain('Taj Bengal, Kolkata');
    expect(html).toContain('Here are the details:');
    expect(html).toContain('+91 90070 00891');
    expect(html).toContain('Vegetarian');
    for (const icon of ['info', 'event', 'place', 'person', 'call', 'restaurant', 'qr']) expect(html).toContain(`cid:lgpsm-icon-${icon}`);
    expect(html).not.toMatch(/linear-gradient/);
    expect(html).not.toContain('OFFICIAL INVITATION');
  });

  it('shows a food preference only once the guest has chosen one; before that it says where to choose', () => {
    const chosen = buildInvitationEmail({ ...base, asksDietary: true, dietaryPreference: 'Vegetarian' });
    expect(chosen).toContain('>Vegetarian<');
    const first = buildInvitationEmail({ ...base, asksDietary: true, rsvpBy: '2026-11-15T12:00:00Z' });
    expect(first).not.toContain('Vegetarian');
    expect(first).toContain('You will choose this when you reply');
    expect(buildInvitationEmail({ ...base, asksDietary: true })).toContain('You will choose this on your invitation page');
    expect(buildInvitationEmail({ ...base, asksDietary: true, isReminder: true })).toContain('Not chosen yet. Please choose on your invitation page');
    // an event that does not ask for food has no food row at all
    expect(buildInvitationEmail(base)).not.toContain('cid:lgpsm-icon-restaurant');
  });

  it("has the organizer's logo at the top (LGPSM's until they upload one), the card, and one button to the invitation", () => {
    const html = buildInvitationEmail(base);
    expect(html.match(/cid:logo-1/g)?.length).toBe(1);
    expect(html).not.toContain('cid:lgpsm-logo');
    expect(buildInvitationEmail({ ...base, organizerLogoCid: undefined })).toContain('src="cid:lgpsm-logo"');
    expect(html).toContain('cid:card-1');
    expect(html.match(/href="https:\/\/lgpsm.example\/invitation\/abc"/g)?.length).toBe(2); // the button and the fallback link
    expect(html).toContain('href="https://lgpsm.example/invitation/abc?view=card"');
    expect(html).toContain('Organized by <strong>Iconic Events</strong>');
  });

  it('places the entry QR once: on the card when there is one, on its own otherwise', () => {
    const withCard = buildInvitationEmail(base);
    expect(withCard).not.toContain('cid:qr-1');
    expect(withCard).toContain('show its QR code at the entrance');
    const noCard = buildInvitationEmail({ ...base, cardCid: undefined });
    expect(noCard).toContain('cid:qr-1');
    expect(noCard).toContain('show the QR code at the entrance');
    const without = buildInvitationEmail({ ...base, cardCid: undefined, showQr: false });
    expect(without).not.toContain('cid:qr-1');
    expect(without).toContain('open it on your phone at the entrance');
  });

  it('escapes everything a person typed', () => {
    const html = buildInvitationEmail({ ...base, eventTitle: '<script>x</script>', inviteeName: 'A & B', venue: '"Hall" <1>', description: '<img src=x onerror=alert(1)>', organizerName: '<b>Org</b>' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>Org</b>');
    expect(html).toContain('A &amp; B');
  });

  it('a reminder says so, and the RSVP date is asked for in the invitation only', () => {
    const invite = buildInvitationEmail({ ...base, rsvpBy: '2026-11-15T12:00:00Z' });
    expect(invite).toContain('Please reply by:');
    expect(invite).toContain('View invitation &amp; reply');
    const reminder = buildInvitationEmail({ ...base, rsvpBy: '2026-11-15T12:00:00Z', isReminder: true });
    expect(reminder).toContain('friendly reminder');
    expect(reminder).toContain('Annual Leadership Summit 2026 is coming up</h1>');
    expect(reminder).not.toContain('Please reply by:');
    expect(invitationEmailSubject('Summit')).toBe("You're invited: Summit");
    expect(invitationEmailSubject('Summit', true)).toBe('Reminder: Summit is coming up');
  });

  it('online events, missing organizer details and multi-day events still read properly', () => {
    const html = buildInvitationEmail({ ...base, isVirtual: true, organizerName: undefined, organizerLogoCid: undefined, contactNumber: undefined });
    expect(html).toContain("We're delighted to invite you to");
    expect(html).toContain('>Online<');
    expect(html).not.toContain('cid:lgpsm-icon-call');
    expect(html).toContain('simply reply to this email');
    expect(html).toContain('Organized via <strong>LGPSM Platform</strong>');
    expect(whenSentence('2026-11-21T13:30:00Z', '2026-11-23T16:30:00Z')?.full).toBe('from Sat, 21 Nov 2026, 7:00 PM to Mon, 23 Nov 2026, 10:00 PM');
  });
});

describe('the inline images', () => {
  it('attaches exactly the icons and logo an email uses, as PNGs', async () => {
    const { inlineImagesFor } = await import('../src/services/email/emailImages');
    const html = buildInvitationEmail({ ...base, organizerLogoCid: undefined, contactNumber: undefined });
    const files = await inlineImagesFor(html);
    const cids = files.map((f) => f.cid).sort();
    expect(cids).toEqual(['lgpsm-icon-event', 'lgpsm-icon-info', 'lgpsm-icon-person', 'lgpsm-icon-place', 'lgpsm-icon-qr', 'lgpsm-logo']);
    for (const f of files) expect((f.content as Buffer).subarray(1, 4).toString()).toBe('PNG');
  });
});
