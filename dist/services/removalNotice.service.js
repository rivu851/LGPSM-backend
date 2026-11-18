"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.removalNoticeService = void 0;
const html_1 = require("../utils/html");
const email_provider_1 = require("../utils/email.provider");
const whatsapp_service_1 = require("./whatsapp.service");
function removalEmail(a) {
    return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#15191c">
<h2 style="margin:0 0 12px">You were removed from the guest list</h2>
<p>Dear ${(0, html_1.escapeHtml)(a.guest)},</p>
<p>You have been removed from the guest list of <strong>${(0, html_1.escapeHtml)(a.title)}</strong>. Any invitation or access pass you received for it is <strong>no longer valid</strong>.</p>
<p><strong>Reason from the organizer:</strong><br>${(0, html_1.escapeHtml)(a.reason).replace(/\n/g, '<br>')}</p></div>`;
}
exports.removalNoticeService = {
    async notify(guest, eventTitle, reason, channels) {
        const out = { email: 'SKIPPED', whatsapp: 'SKIPPED', reasons: [] };
        if (channels.email) {
            if (!guest.email) {
                out.email = 'UNAVAILABLE';
                out.reasons.push('No email address on record');
            }
            else {
                try {
                    await (0, email_provider_1.sendEmail)(guest.email, `Removed from the guest list: ${eventTitle}`, removalEmail({ guest: guest.name, title: eventTitle, reason }));
                    out.email = 'SENT';
                }
                catch (err) {
                    const msg = String(err?.message || '');
                    out.email = msg === 'PROVIDER_NOT_CONFIGURED' ? 'UNAVAILABLE' : 'FAILED';
                    out.reasons.push(msg === 'PROVIDER_NOT_CONFIGURED' ? 'Email provider is not configured' : 'The email provider did not accept the message');
                }
            }
        }
        if (channels.whatsapp) {
            if (!guest.mobile) {
                out.whatsapp = 'UNAVAILABLE';
                out.reasons.push('No mobile number on record');
            }
            else {
                try {
                    await whatsapp_service_1.whatsappService.sendRemovalWhatsApp({ recipientPhone: guest.mobile, inviteeName: guest.name, eventTitle, reason });
                    out.whatsapp = 'SENT';
                }
                catch (err) {
                    const msg = String(err?.message || '');
                    out.whatsapp = /^(WHATSAPP_CONFIG_MISSING|WHATSAPP_REMOVAL_TEMPLATE_NOT_CONFIGURED)/.test(msg) ? 'UNAVAILABLE' : 'FAILED';
                    out.reasons.push((0, whatsapp_service_1.describeWhatsAppError)(msg));
                }
            }
        }
        return out;
    }
};
