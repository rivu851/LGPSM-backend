import { Request, Response } from 'express';
import { publicInvitationService } from '../services/publicInvitation.service';
import { invitationService } from '../services/invitation.service';

export const publicInvitationController = {
  async getPublicInvitationCard(req: Request, res: Response) {
    try {
      const token = req.params.token as string;
      const png = await invitationService.publicInvitationCard(token);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', 'inline; filename="digital-access-pass.png"');
      return res.status(200).send(png);
    } catch (error: any) {
      if (error.message === 'INVITATION_NOT_FOUND' || error.message === 'INVALID_TOKEN') {
        return res.status(404).json({ success: false, message: 'Invitation not found or token is invalid' });
      }
      console.error('Request failed:', error?.message);
      return res.status(500).json({ success: false, message: 'Could not render the digital pass.' });
    }
  },

  async getPublicInvitation(req: Request, res: Response) {
    try {
      const token = req.params.token as string;
      const data = await publicInvitationService.getPublicInvitation(token);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      if (error.message === 'INVITATION_NOT_FOUND' || error.message === 'INVALID_TOKEN') {
        return res.status(404).json({ success: false, error: 'Not Found', message: 'Invitation not found or token is invalid' });
      }
      console.error('Request failed:', error?.message);
      return res.status(500).json({ success: false, error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  async submitRsvp(req: Request, res: Response) {
    try {
      const token = req.params.token as string;
      const { rsvpStatus, dietarySelections, dietaryPreference } = req.body;

      const data = await publicInvitationService.submitRsvp(token, rsvpStatus, dietarySelections, dietaryPreference);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      if (error.message === 'INVITATION_NOT_FOUND' || error.message === 'INVALID_TOKEN') {
        return res.status(404).json({ success: false, error: 'Not Found', message: 'Invitation not found or token is invalid' });
      }
      if (error.message === 'EVENT_CANCELLED') {
        return res.status(410).json({ success: false, message: 'This event has been cancelled.' });
      }
      if (error.message === 'RSVP_DISABLED') {
        return res.status(400).json({ success: false, message: 'RSVP is not open for this event.' });
      }
      if (error.message === 'RSVP_CLOSED') {
        return res.status(400).json({ success: false, message: 'The RSVP deadline for this event has passed.' });
      }
      if (error.message === 'INVALID_DIETARY_PREFERENCE') {
        return res.status(400).json({ success: false, message: 'Choose only from the dietary options provided for this event.' });
      }
      console.error('Request failed:', error?.message);
      return res.status(500).json({ success: false, error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  }
};
