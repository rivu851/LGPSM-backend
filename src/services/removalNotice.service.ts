import { escapeHtml } from '../utils/html';
import { sendEmail } from '../utils/email.provider';
import { whatsappService, describeWhatsAppError } from './whatsapp.service';

// The message a guest gets when the organizer removes them from an event's guest list. Best-effort and reported honestly per channel:
// the removal itself never depends on a provider, and nothing is claimed as sent unless the provider accepted it.

export type RemovalChannelState = 'SENT' | 'FAILED' | 'UNAVAILABLE' | 'SKIPPED';
export interface RemovalNoticeResult { email: RemovalChannelState; whatsapp: RemovalChannelState; reasons: string[] }

function removalEmail(a: { guest: string; title: string; reason: string }) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#15191c">
<h2 style="margin:0 0 12px">You were removed from the guest list</h2>
<p>Dear ${escapeHtml(a.guest)},</p>
<p>You have been removed from the guest list of <strong>${escapeHtml(a.title)}</strong>. Any invitation or access pass you received for it is <strong>no longer valid</strong>.</p>
<p><strong>Reason from the organizer:</strong><br>${escapeHtml(a.reason).replace(/\n/g, '<br>')}</p></div>`;
}

export const removalNoticeService = {
  async notify(guest: { name: string; email?: string; mobile?: string }, eventTitle: string, reason: string, channels: { email?: boolean; whatsapp?: boolean }): Promise<RemovalNoticeResult> {
    const out: RemovalNoticeResult = { email: 'SKIPPED', whatsapp: 'SKIPPED', reasons: [] };
    if (channels.email) {
      if (!guest.email) { out.email = 'UNAVAILABLE'; out.reasons.push('No email address on record'); }
      else {
        try { await sendEmail(guest.email, `Removed from the guest list: ${eventTitle}`, removalEmail({ guest: guest.name, title: eventTitle, reason })); out.email = 'SENT'; }
        catch (err: any) {
          const msg = String(err?.message || '');
          out.email = msg === 'PROVIDER_NOT_CONFIGURED' ? 'UNAVAILABLE' : 'FAILED';
          out.reasons.push(msg === 'PROVIDER_NOT_CONFIGURED' ? 'Email provider is not configured' : 'The email provider did not accept the message');
        }
      }
    }
    if (channels.whatsapp) {
      if (!guest.mobile) { out.whatsapp = 'UNAVAILABLE'; out.reasons.push('No mobile number on record'); }
      else {
        try { await whatsappService.sendRemovalWhatsApp({ recipientPhone: guest.mobile, inviteeName: guest.name, eventTitle, reason }); out.whatsapp = 'SENT'; }
        catch (err: any) {
          const msg = String(err?.message || '');
          out.whatsapp = /^(WHATSAPP_CONFIG_MISSING|WHATSAPP_REMOVAL_TEMPLATE_NOT_CONFIGURED)/.test(msg) ? 'UNAVAILABLE' : 'FAILED';
          out.reasons.push(describeWhatsAppError(msg));
        }
      }
    }
    return out;
  }
};
