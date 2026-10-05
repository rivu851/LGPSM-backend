import { Request, Response } from 'express';
import { invitationService } from '../services/invitation.service';
import { DeliveryChannel } from '../models/Invitation';

export const invitationController = {
  async sendInvitations(req: Request, res: Response) {
    try {
      const eventId = req.params.eventId as string;
      const { inviteeIds, channel, channels } = req.body;
      const user = {
        userId: (req as any).user?.userId,
        role: (req as any).user?.role
      };

      let selectedChannel: DeliveryChannel = channel;
      if (!selectedChannel && Array.isArray(channels)) {
        const hasEmail = channels.includes('EMAIL');
        const hasWhatsApp = channels.includes('WHATSAPP');
        if (hasEmail && hasWhatsApp) {
          selectedChannel = DeliveryChannel.BOTH;
        } else if (hasWhatsApp) {
          selectedChannel = DeliveryChannel.WHATSAPP;
        } else if (hasEmail) {
          selectedChannel = DeliveryChannel.EMAIL;
        }
      }

      const results = await invitationService.sendInvitations(eventId, user, inviteeIds, selectedChannel || DeliveryChannel.EMAIL);
      return res.status(200).json({ success: true, message: 'Invitations processed successfully', results });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Event not found or access denied' });
      if (error.message === 'INVALID_INVITEES') return res.status(400).json({ error: 'Bad Request', message: 'One or more invitees do not belong to this event' });
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  },

  async resendInvitations(req: Request, res: Response) {
    try {
      const eventId = req.params.eventId as string;
      const { invitationIds, channel } = req.body;
      const user = {
        userId: (req as any).user?.userId,
        role: (req as any).user?.role
      };

      const results = await invitationService.resendInvitations(eventId, user, invitationIds, channel);
      return res.status(200).json({ success: true, message: 'Invitations resent successfully', results });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Event not found or access denied' });
      if (error.message === 'INVALID_INVITATIONS') return res.status(400).json({ error: 'Bad Request', message: 'One or more invitations do not belong to this event' });
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  },

  async getInvitations(req: Request, res: Response) {
    try {
      const eventId = req.params.eventId as string;
      const user = {
        userId: (req as any).user?.userId,
        role: (req as any).user?.role
      };
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;

      const data = await invitationService.getInvitations(eventId, user, page, limit);
      return res.status(200).json(data);
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Event not found or access denied' });
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  },

  async previewInvitationCard(req: Request, res: Response) {
    try {
      const eventId = req.params.eventId as string;
      const inviteeId = req.query.inviteeId as string | undefined;
      const user = {
        userId: (req as any).user?.userId,
        role: (req as any).user?.role
      };

      const { png: pngBuffer, qr } = await invitationService.previewInvitationCard(eventId, user, inviteeId);
      res.setHeader('Content-Type', 'image/png');
      // ISSUED: the QR is the guest's current check-in pass; SAMPLE: placeholder, not valid for check-in
      res.setHeader('X-Invitation-Qr', qr);
      res.setHeader('Content-Disposition', 'inline; filename="invitation-card-preview.png"');
      return res.status(200).send(pngBuffer);
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Event not found' });
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  }
};

