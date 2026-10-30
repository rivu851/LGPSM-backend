import { env } from '../config/env';

export function normalizePhoneNumber(phone?: string): string {
  if (!phone || typeof phone !== 'string') return '';
  let cleaned = phone.replace(/\D/g, '');
  cleaned = cleaned.replace(/^0+/, '');

  if (cleaned.length === 10) {
    cleaned = `91${cleaned}`;
  }
  return cleaned;
}

export interface SendWhatsAppTemplateParams {
  recipientPhone: string;
  mediaId: string;
  inviteeName: string;
  eventTitle: string;
  eventDate: string;
  eventTime: string;
  venue: string;
}

export interface SendWhatsAppInvitationParams {
  recipientPhone: string;
  qrBuffer: Buffer;
  inviteeName: string;
  eventTitle: string;
  eventDate: string;
  eventTime: string;
  venue: string;
}

/**
 * The organizer sees why a WhatsApp delivery failed; the internal codes ("WHATSAPP_MEDIA_UPLOAD_FAILED: ...") read as a bug, so
 * known ones get a plain sentence and keep the provider's own detail.
 */
export function describeWhatsAppError(message: string | undefined): string {
  const raw = String(message || '').trim();
  const [code, ...rest] = raw.split(':');
  const detail = rest.join(':').trim();
  const withDetail = (text: string) => (detail ? `${text} (${detail})` : text);
  switch (code) {
    case 'WHATSAPP_CONFIG_MISSING': return 'WhatsApp is not set up on the server';
    case 'WHATSAPP_MEDIA_UPLOAD_FAILED': return withDetail('WhatsApp did not accept the invitation image');
    case 'WHATSAPP_CANCELLATION_TEMPLATE_NOT_CONFIGURED': return 'No WhatsApp cancellation template is configured';
    case 'WHATSAPP_PASS_TEMPLATE_NOT_CONFIGURED': return 'No WhatsApp template for access-pass messages is configured';
    case 'WHATSAPP_TEMPLATE_SEND_FAILED': return withDetail('WhatsApp did not deliver the message');
    default: return raw || 'WhatsApp delivery failed';
  }
}

export const whatsappService = {
  normalizePhoneNumber,

  async uploadMedia(qrBuffer: Buffer): Promise<string> {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || env.WHATSAPP_PHONE_NUMBER_ID;
    const apiVersion = process.env.WHATSAPP_API_VERSION || env.WHATSAPP_API_VERSION || 'v25.0';

    if (!accessToken) {
      throw new Error('WHATSAPP_CONFIG_MISSING: Access token not configured');
    }
    if (!phoneNumberId) {
      throw new Error('WHATSAPP_CONFIG_MISSING: Phone number ID not configured');
    }

    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    const blob = new Blob([qrBuffer], { type: 'image/png' });
    formData.append('file', blob, 'invitation-qr.png');

    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/media`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: formData,
    });

    const data: any = await response.json();

    if (!response.ok || !data.id) {
      const errMsg = data.error?.message || data.error?.error_data?.details || 'Media upload failed';
      throw new Error(`WHATSAPP_MEDIA_UPLOAD_FAILED: ${errMsg}`);
    }

    return data.id as string;
  },

  async sendTemplateMessage(params: SendWhatsAppTemplateParams): Promise<{ messageId: string }> {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || env.WHATSAPP_PHONE_NUMBER_ID;
    const apiVersion = process.env.WHATSAPP_API_VERSION || env.WHATSAPP_API_VERSION || 'v25.0';
    const templateName = process.env.WHATSAPP_INVITATION_TEMPLATE || env.WHATSAPP_INVITATION_TEMPLATE || 'lgpsm_event_invitation';
    const languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE || env.WHATSAPP_TEMPLATE_LANGUAGE || 'en';

    if (!accessToken) {
      throw new Error('WHATSAPP_CONFIG_MISSING: Access token not configured');
    }
    if (!phoneNumberId) {
      throw new Error('WHATSAPP_CONFIG_MISSING: Phone number ID not configured');
    }

    const formattedPhone = normalizePhoneNumber(params.recipientPhone);
    if (!formattedPhone || formattedPhone.length < 10 || formattedPhone.length > 15) {
      throw new Error('INVALID_PHONE_NUMBER: Phone number format is invalid');
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedPhone,
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: languageCode,
        },
        components: [
          {
            type: 'header',
            parameters: [
              {
                type: 'image',
                image: {
                  id: params.mediaId,
                },
              },
            ],
          },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: params.inviteeName || 'Guest' },
              { type: 'text', text: params.eventTitle || 'Event' },
              { type: 'text', text: params.eventDate || 'TBA' },
              { type: 'text', text: params.eventTime || 'TBA' },
              { type: 'text', text: params.venue || 'TBA' },
            ],
          },
        ],
      },
    };

    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data: any = await response.json();

    if (!response.ok) {
      const errMsg = data.error?.message || data.error?.error_data?.details || 'WhatsApp API request failed';
      throw new Error(`WHATSAPP_TEMPLATE_SEND_FAILED: ${errMsg}`);
    }

    const messageId = data.messages?.[0]?.id || '';
    return { messageId };
  },

  /**
   * Tells a guest the event was cancelled, using an approved template (business-initiated messages need one).
   * With no `WHATSAPP_CANCELLATION_TEMPLATE` this refuses before calling Meta, so nothing is ever claimed as sent.
   * A returned message id means Meta accepted the request, not that the guest received it.
   */
  async sendCancellationWhatsApp(params: { recipientPhone: string; inviteeName: string; eventTitle: string; eventDate: string }): Promise<{ messageId: string }> {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || env.WHATSAPP_PHONE_NUMBER_ID;
    const apiVersion = process.env.WHATSAPP_API_VERSION || env.WHATSAPP_API_VERSION || 'v25.0';
    const templateName = process.env.WHATSAPP_CANCELLATION_TEMPLATE || env.WHATSAPP_CANCELLATION_TEMPLATE;
    const languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE || env.WHATSAPP_TEMPLATE_LANGUAGE || 'en';

    if (!accessToken) throw new Error('WHATSAPP_CONFIG_MISSING: Access token not configured');
    if (!phoneNumberId) throw new Error('WHATSAPP_CONFIG_MISSING: Phone number ID not configured');
    if (!templateName) throw new Error('WHATSAPP_CANCELLATION_TEMPLATE_NOT_CONFIGURED');

    const formattedPhone = normalizePhoneNumber(params.recipientPhone);
    if (!formattedPhone || formattedPhone.length < 10 || formattedPhone.length > 15) {
      throw new Error('INVALID_PHONE_NUMBER: Phone number format is invalid');
    }

    const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: formattedPhone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: params.inviteeName || 'Guest' },
              { type: 'text', text: params.eventTitle || 'Event' },
              { type: 'text', text: params.eventDate || 'the scheduled date' }
            ]
          }]
        }
      }),
      signal: AbortSignal.timeout(15_000)
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`WHATSAPP_TEMPLATE_SEND_FAILED: ${data.error?.message || data.error?.error_data?.details || 'WhatsApp API request failed'}`);
    }
    return { messageId: data.messages?.[0]?.id || '' };
  },

  /**
   * Tells a guest their access pass was replaced (with the new card) or revoked, through an approved template. With no template
   * configured, or no credentials, it refuses before calling Meta, so nothing is ever claimed as sent. A message id means Meta
   * accepted the request, not that the guest received it.
   */
  async sendPassWhatsApp(params: { kind: 'REPLACED' | 'REVOKED'; recipientPhone: string; inviteeName: string; eventTitle: string; eventDate: string; cardBuffer?: Buffer }): Promise<{ messageId: string }> {
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN || env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || env.WHATSAPP_PHONE_NUMBER_ID;
    const apiVersion = process.env.WHATSAPP_API_VERSION || env.WHATSAPP_API_VERSION || 'v25.0';
    const templateName = params.kind === 'REPLACED'
      ? process.env.WHATSAPP_REPLACEMENT_TEMPLATE || env.WHATSAPP_REPLACEMENT_TEMPLATE
      : process.env.WHATSAPP_REVOCATION_TEMPLATE || env.WHATSAPP_REVOCATION_TEMPLATE;
    const languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE || env.WHATSAPP_TEMPLATE_LANGUAGE || 'en';

    if (!accessToken) throw new Error('WHATSAPP_CONFIG_MISSING: Access token not configured');
    if (!phoneNumberId) throw new Error('WHATSAPP_CONFIG_MISSING: Phone number ID not configured');
    if (!templateName) throw new Error('WHATSAPP_PASS_TEMPLATE_NOT_CONFIGURED');

    const formattedPhone = normalizePhoneNumber(params.recipientPhone);
    if (!formattedPhone || formattedPhone.length < 10 || formattedPhone.length > 15) {
      throw new Error('INVALID_PHONE_NUMBER: Phone number format is invalid');
    }
    const components: any[] = [];
    if (params.kind === 'REPLACED') {
      if (!params.cardBuffer) throw new Error('WHATSAPP_MEDIA_UPLOAD_FAILED: No card to send');
      const mediaId = await this.uploadMedia(params.cardBuffer);
      components.push({ type: 'header', parameters: [{ type: 'image', image: { id: mediaId } }] });
    }
    components.push({ type: 'body', parameters: [
      { type: 'text', text: params.inviteeName || 'Guest' },
      { type: 'text', text: params.eventTitle || 'Event' },
      { type: 'text', text: params.eventDate || 'the scheduled date' }
    ] });

    const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: formattedPhone, type: 'template', template: { name: templateName, language: { code: languageCode }, components } }),
      signal: AbortSignal.timeout(15_000)
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`WHATSAPP_TEMPLATE_SEND_FAILED: ${data.error?.message || data.error?.error_data?.details || 'WhatsApp API request failed'}`);
    return { messageId: data.messages?.[0]?.id || '' };
  },

  async sendInvitationWhatsApp(params: SendWhatsAppInvitationParams): Promise<{ messageId: string; mediaId: string }> {
    const mediaId = await this.uploadMedia(params.qrBuffer);
    const { messageId } = await this.sendTemplateMessage({
      recipientPhone: params.recipientPhone,
      mediaId,
      inviteeName: params.inviteeName,
      eventTitle: params.eventTitle,
      eventDate: params.eventDate,
      eventTime: params.eventTime,
      venue: params.venue,
    });

    return { messageId, mediaId };
  },
};
