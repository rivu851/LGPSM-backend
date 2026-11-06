import { env } from '../../config/env';
import { escapeHtml } from '../../utils/html';
import { contactForCard } from '../cardTemplates/coverage';
import { EmailIconKey, iconCid, PLATFORM_LOGO_CID } from './emailImages';

/**
 * The invitation (and reminder) email a guest receives, laid out the way Google's account notices are: a white page with one
 * thin-bordered sheet, the logo centred at the top (the organizer's once uploaded, the LGPSM logo until then), a large headline
 * and the guest's own chip, the event's card design where those notices put their illustration, a soft blue note saying why the
 * guest got this email, a rounded details panel with an icon per line, an oval button, and a bordered entry-pass card.
 * Only inline-styled tables and PNG icons (attached by cid, see emailImages.ts) are used, so Gmail and phone apps render it as is.
 * Everything that came from a person (event title, names, venue, description) is escaped before it reaches the HTML.
 */
export interface InvitationEmailInput {
  eventTitle: string;
  inviteeName: string;
  /** shown under the headline, beside the guest's initial */
  inviteeEmail?: string;
  /** The event's start and end; written out in the platform's time zone */
  startIso?: string | Date | null;
  endIso?: string | Date | null;
  venue?: string;
  locationSub?: string;
  isVirtual?: boolean;
  description?: string;
  contactNumber?: string;
  /** When guests are asked to answer by (RSVP on) */
  rsvpBy?: string | Date | null;
  /** what the guest already chose (known only after they have answered on their invitation page) */
  dietaryPreference?: string;
  /** the event asks guests for a food preference: they choose it on the invitation page, so until then the email only says so */
  asksDietary?: boolean;
  invitationUrl: string;
  /** inline image ids (cid:) of the attachments */
  qrCid: string;
  cardCid?: string;
  organizerLogoCid?: string;
  organizerName?: string;
  /** false when the organizer chose cards without a QR ("Select data to show on card"): the email then has no QR either */
  showQr?: boolean;
  isReminder?: boolean;
}

const FONT = "'Google Sans', Roboto, 'Helvetica Neue', Arial, sans-serif";
const INK = '#1F1F1F';
const MUTED = '#444746';
const SOFT = '#5E5E5E';
const BLUE = '#0B57D0';
const NOTE_BG = '#D3E3FD';
const PANEL_BG = '#F8FAFD';
const LINE = '#DADCE0';

const toDate = (v?: string | Date | null) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: env.APP_TIMEZONE, ...o }).format(d).replace(/[  ]/g, ' ');
const longDate = (d: Date) => fmt(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = (d: Date) => fmt(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const time = (d: Date) => fmt(d, { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
const sameDay = (a: Date, b: Date) => fmt(a, { dateStyle: 'short' }) === fmt(b, { dateStyle: 'short' });

/** "Saturday, 21 November 2026, from 7:00 PM to 10:00 PM" (one day) or "from Sat, 21 Nov 2026, 7:00 PM to Mon, 23 Nov 2026, 10:00 PM" */
export function whenSentence(startIso?: string | Date | null, endIso?: string | Date | null): { date: string; time: string; full: string } | null {
  const start = toDate(startIso);
  if (!start) return null;
  const end = toDate(endIso);
  if (!end || end <= start) return { date: longDate(start), time: `from ${time(start)}`, full: `${longDate(start)}, from ${time(start)}` };
  if (sameDay(start, end)) return { date: longDate(start), time: `${time(start)} to ${time(end)}`, full: `${longDate(start)}, from ${time(start)} to ${time(end)}` };
  return { date: `${shortDate(start)} to ${shortDate(end)}`, time: `${time(start)} to ${time(end)}`, full: `from ${shortDate(start)}, ${time(start)} to ${shortDate(end)}, ${time(end)}` };
}

export function invitationEmailSubject(eventTitle: string, isReminder = false): string {
  return isReminder ? `Reminder: ${eventTitle} is coming up` : `You're invited: ${eventTitle}`;
}

export function buildInvitationEmail(input: InvitationEmailInput): string {
  const e = escapeHtml;
  const title = e(input.eventTitle);
  const guest = e(input.inviteeName);
  const guestEmail = input.inviteeEmail?.trim() ? e(input.inviteeEmail.trim()) : '';
  const initial = e((input.inviteeName.trim()[0] || '?').toUpperCase());
  const host = input.organizerName?.trim() ? e(input.organizerName.trim()) : '';
  const when = whenSentence(input.startIso, input.endIso);
  const venueLine = input.isVirtual ? 'Online' : [input.venue, input.locationSub].filter((v) => v && v.trim()).map((v) => e(v!.trim())).join(', ');
  const description = input.description?.trim() ? e(input.description.trim()) : '';
  const contact = input.contactNumber ? e(contactForCard(input.contactNumber)) : '';
  const rsvpBy = input.isReminder ? null : toDate(input.rsvpBy);
  const dietary = input.dietaryPreference?.trim() ? e(input.dietaryPreference.trim()) : '';
  const showQr = input.showQr !== false;
  // the QR is placed once: on the invitation card when there is one (it is printed there), on its own only when there is no card image
  const standaloneQr = showQr && !input.cardCid;
  const link = e(input.invitationUrl);
  const cardLink = e(`${input.invitationUrl}${input.invitationUrl.includes('?') ? '&' : '?'}view=card`);
  const logoCid = input.organizerLogoCid || PLATFORM_LOGO_CID;

  const b = (t: string) => `<strong style="font-weight:700;color:${INK};">${t}</strong>`;
  const text = (html: string, extra = '') => `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK};${extra}">${html}</p>`;
  const icon = (key: EmailIconKey, size = 24) => `<img src="cid:${iconCid(key)}" alt="" width="${size}" height="${size}" style="display:block;width:${size}px;height:${size}px;border:0;" />`;

  // ---- headline ----
  const headline = input.isReminder ? `${title} is coming up` : `You're invited to ${title}`;

  // ---- the blue note: why the guest got this email ----
  const noteFirst = input.isReminder
    ? `This is a friendly reminder that you're invited to ${b(title)}${when ? ` on ${b(when.date)}, ${b(when.time)}` : ''}.`
    : `${host ? `${b(host)} is` : "We're"} delighted to invite you to ${b(title)}${when ? `, taking place on ${b(when.date)}, ${b(when.time)}` : ''}${venueLine ? `, ${input.isVirtual ? '' : 'at '}${b(venueLine)}` : ''}.`;
  const noteSecond = input.isReminder
    ? "We're looking forward to seeing you there. Your invitation and entry pass are below."
    : 'This email has your personal invitation card and everything you need for the day.';

  // ---- the details panel ----
  const row = (key: EmailIconKey, main: string, sub: string) => `
              <tr>
                <td valign="top" width="24" style="padding:0 0 18px 0;">${icon(key)}</td>
                <td valign="top" style="padding:1px 0 18px 16px;font-family:${FONT};">
                  <div style="font-size:15px;line-height:1.4;color:${INK};">${main}</div>
                  <div style="font-size:12px;line-height:1.5;color:${MUTED};padding-top:2px;">${sub}</div>
                </td>
              </tr>`;
  const venueParts = input.isVirtual ? null : [input.venue, input.locationSub].map((v) => (v?.trim() ? e(v.trim()) : '')).filter(Boolean);
  const rows = [
    when ? row('event', e(when.date), e(when.time.charAt(0).toUpperCase() + when.time.slice(1))) : '',
    input.isVirtual ? row('place', 'Online', 'The joining link is on your invitation page')
      : venueParts?.length ? row('place', venueParts[0], venueParts.slice(1).join(', ') || 'Venue') : '',
    host ? row('person', host, 'Hosted by') : '',
    // a saved choice is shown as the guest's own; otherwise (the usual case at first invitation) the email says where to choose it
    dietary ? row('restaurant', dietary, 'Your food preference')
      : input.asksDietary && !input.isReminder ? row('restaurant', 'Food preference', rsvpBy ? 'You will choose this when you reply' : 'You will choose this on your invitation page')
      : input.asksDietary ? row('restaurant', 'Food preference', 'Not chosen yet. Please choose on your invitation page') : '',
    contact ? row('call', `<a href="tel:${e(contact.replace(/[^+\d]/g, ''))}" style="color:${INK};text-decoration:none;">${contact}</a>`, 'For any questions') : '',
  ].join('');
  const panelFoot = rsvpBy
    ? `Please reply by: ${b(e(longDate(rsvpBy)))}`
    : `This invitation is personal to ${b(guest)}`;

  // ---- the entry pass ----
  const passLine = !showQr
    ? `Your personal entry pass is on your invitation page. Please ${b('open it on your phone at the entrance')}; it is unique to you, so please don't share it.`
    : standaloneQr
      ? `Your personal entry pass is below. Please ${b('show the QR code at the entrance')} when you arrive; it is unique to you, so please don't share it.`
      : `Your invitation card above is your personal entry pass. Please ${b('show its QR code at the entrance')} when you arrive; it is unique to you, so please don't share it.`;

  const button = (label: string, href: string) => `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:4px auto 24px auto;">
            <tr><td align="center" bgcolor="${BLUE}" style="border-radius:100px;background:${BLUE};">
              <a href="${href}" target="_blank" style="display:inline-block;padding:14px 36px;font-family:${FONT};font-size:16px;font-weight:500;color:#FFFFFF;text-decoration:none;border-radius:100px;">${label}</a>
            </td></tr>
          </table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="x-apple-disable-message-reformatting">
<title>${title}</title>
<style>
  body{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  img{-ms-interpolation-mode:bicubic;}
  @media only screen and (max-width:600px){
    .wrap{padding:0 !important;}
    .sheet{border:0 !important;border-radius:0 !important;}
    .pad{padding-left:16px !important;padding-right:16px !important;}
    .pn{padding-left:16px !important;padding-right:16px !important;}
    .note-i{padding:14px 0 14px 12px !important;}
    .note-t{padding:14px 12px 14px 10px !important;font-size:14px !important;line-height:1.55 !important;}
    h1{font-size:21px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#FFFFFF;">
  <!-- preview text shown next to the subject in the inbox -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${input.isReminder ? `${title} is coming up` : `${host ? `${host} invites you to ` : 'You are invited to '}${title}`}${when ? ` on ${e(when.date)}` : ''}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;">
    <tr><td align="center" class="wrap" style="padding:24px 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="sheet" style="max-width:640px;background:#FFFFFF;border:1px solid ${LINE};border-radius:8px;">

        <!-- logo, headline and the guest's chip -->
        <tr><td align="center" class="pad" style="padding:32px 24px 0 24px;">
          <img src="cid:${logoCid}" alt="${host ? `${host} logo` : 'LGPSM'}" height="48" style="display:block;height:48px;width:auto;max-width:180px;border:0;margin:0 auto;" />
          <h1 style="margin:20px 0 16px 0;font-family:${FONT};font-size:24px;line-height:1.35;font-weight:400;color:${INK};">${headline}</h1>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>
            <td valign="middle" width="26" height="26" align="center" bgcolor="#0F3190" style="width:26px;height:26px;border-radius:13px;background:#0F3190;font-family:${FONT};font-size:13px;line-height:26px;color:#FFFFFF;">${initial}</td>
            <td valign="middle" style="padding-left:10px;font-family:${FONT};font-size:14px;font-weight:500;color:${INK};">${guestEmail || guest}</td>
          </tr></table>
        </td></tr>
        <tr><td class="pad" style="padding:24px 24px 0 24px;"><div style="border-top:1px solid ${LINE};font-size:0;line-height:0;">&nbsp;</div></td></tr>

        ${input.cardCid ? `
        <!-- the event's own card design; tapping it opens it full screen on the invitation page -->
        <tr><td align="center" class="pad" style="padding:28px 24px 0 24px;">
          <a href="${cardLink}" target="_blank" style="text-decoration:none;"><img src="cid:${input.cardCid}" alt="Your invitation card for ${title}" width="280" style="display:block;width:100%;max-width:280px;height:auto;border:0;border-radius:12px;" /></a>
          <p style="margin:8px 0 0 0;font-family:${FONT};font-size:12px;color:${SOFT};">Tap the card to open it full screen</p>
        </td></tr>` : ''}

        <!-- the note: who invited the guest to what -->
        <tr><td class="pad" style="padding:24px 24px 0 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${NOTE_BG}" style="background:${NOTE_BG};border-radius:16px;">
            <tr>
              <td valign="top" width="24" class="note-i" style="padding:18px 0 18px 16px;">${icon('info')}</td>
              <td valign="top" class="note-t" style="padding:18px 16px 18px 12px;font-family:${FONT};font-size:15px;line-height:1.6;color:${INK};">
                <p style="margin:0 0 12px 0;">${input.isReminder ? 'Hi' : 'Dear'} ${b(guest)},</p>
                <p style="margin:0 0 12px 0;">${noteFirst}</p>
                <p style="margin:0;">${noteSecond}</p>
              </td>
            </tr>
          </table>
        </td></tr>

        ${description ? `
        <tr><td class="pad" style="padding:24px 24px 0 24px;">
          <p style="margin:0 0 6px 0;font-family:${FONT};font-size:13px;font-weight:500;letter-spacing:0.4px;text-transform:uppercase;color:${SOFT};">About the event</p>
          ${text(description, `color:${MUTED};margin:0;`)}
        </td></tr>` : ''}

        <!-- the details panel -->
        <tr><td class="pad" style="padding:24px 24px 0 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PANEL_BG}" style="background:${PANEL_BG};border-radius:24px;">
            <tr><td class="pn" style="padding:22px 22px 4px 22px;">
              <p style="margin:0 0 20px 0;font-family:${FONT};font-size:15px;font-weight:500;color:${INK};">Here are the details:</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
              </table>
            </td></tr>
            <tr><td class="pn" style="padding:16px 22px 18px 22px;border-top:2px solid #FFFFFF;font-family:${FONT};font-size:15px;line-height:1.5;color:${INK};">${panelFoot}</td></tr>
          </table>
        </td></tr>

        <!-- the call to action -->
        <tr><td class="pad" style="padding:28px 24px 0 24px;">
          ${text(rsvpBy
            ? `Please let ${host || 'us'} know whether you can make it. Your invitation page has the full event details and a one-tap reply.`
            : 'Your invitation page has your card and the full event details.')}
          ${button(rsvpBy ? 'View invitation &amp; reply' : 'View your invitation', link)}
        </td></tr>

        <!-- the entry pass -->
        <tr><td class="pad" style="padding:0 24px 0 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:12px;">
            <tr>
              <td valign="top" width="24" class="note-i" style="padding:16px 0 16px 16px;">${icon('qr')}</td>
              <td valign="top" class="note-t" style="padding:16px 16px 16px 12px;font-family:${FONT};">
                <div style="font-size:15px;font-weight:500;color:${INK};padding-bottom:6px;">Your entry pass</div>
                <div style="font-size:13px;line-height:1.55;color:${MUTED};">${passLine}</div>
              </td>
            </tr>
            ${standaloneQr ? `
            <!-- the guest's entry QR, large and on white so it scans from a phone screen -->
            <tr><td colspan="2" align="center" style="padding:0 20px 20px 20px;">
              <img src="cid:${input.qrCid}" alt="Your entry QR code" width="180" height="180" style="display:block;width:180px;height:180px;border:0;" />
              <p style="margin:8px 0 0 0;font-family:${FONT};font-size:12px;color:${SOFT};">Your entry QR code &middot; for ${guest}</p>
            </td></tr>` : ''}
          </table>
        </td></tr>

        <tr><td class="pad" style="padding:24px 24px 0 24px;">
          ${text(`${contact ? 'If you have any questions, please call us on the number above.' : 'If you have any questions, simply reply to this email.'} ${input.isReminder ? 'See you soon!' : 'We look forward to welcoming you.'}`)}
          ${text(`Warm regards,<br />${b(host || 'The organizing team')}`, 'margin-bottom:0;')}
        </td></tr>

        <!-- footer -->
        <tr><td class="pad" style="padding:24px 24px 32px 24px;">
          <p style="margin:0;padding-top:16px;border-top:1px solid ${LINE};font-family:${FONT};font-size:12px;line-height:1.6;color:${SOFT};">
            ${host ? `Organized by <strong>${host}</strong>` : 'Organized via <strong>LGPSM Platform</strong>'}. This invitation is personal to ${guest}.
            If the button does not work, open this link: <a href="${link}" target="_blank" style="color:${BLUE};word-break:break-all;">${link}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
