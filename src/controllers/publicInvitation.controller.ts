import { Request, Response } from 'express';
import { publicInvitationService } from '../services/publicInvitation.service';
import { invitationService } from '../services/invitation.service';
import { isDatabaseOutage } from '../middlewares/errorHandler';

// A guest who hits a brief outage is told to try again, and nothing was saved
const unavailable = (res: Response, error: any) =>
  isDatabaseOutage(error) ? res.status(503).json({ success: false, code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable. Please try again in a moment.' }) : null;

export const publicInvitationController = {
  async getPublicInvitationCard(req: Request, res: Response) {
    try {
      const token = req.params.token as string;
      const png = await invitationService.publicInvitationCard(token);
      res.setHeader('Content-Type', 'image/png');
      // The invitation page is served from another origin (the web app) and shows this card in an <img>; helmet's default
      // same-origin policy would make the browser refuse to display it. The token in the URL is the access control.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', 'inline; filename="digital-access-pass.png"');
      return res.status(200).send(png);
    } catch (error: any) {
      if (error.message === 'INVITATION_NOT_FOUND' || error.message === 'INVALID_TOKEN') {
        return res.status(404).json({ success: false, message: 'Invitation not found or token is invalid' });
      }
      if (error.message === 'CREDENTIAL_REPLACED') {
        return res.status(410).json({ success: false, code: 'CREDENTIAL_REPLACED', message: 'This access pass was replaced. Please use the new one we sent you.' });
      }
      if (error.message === 'CREDENTIAL_REVOKED') {
        return res.status(410).json({ success: false, code: 'CREDENTIAL_REVOKED', message: 'This access pass has been withdrawn and no longer works.' });
      }
      if (error.message === 'EVENT_CANCELLED') {
        return res.status(410).json({ success: false, code: 'EVENT_CANCELLED', message: 'This event has been cancelled. This access pass is no longer valid.' });
      }
      console.error('Request failed:', error?.message);
      return res.status(500).json({ success: false, message: 'Could not render the digital pass.' });
    }
  },

  // The entry QR alone, for events whose cards are printed without it
  async getPublicInvitationQr(req: Request, res: Response) {
    try {
      const token = req.params.token as string;
      const png = await invitationService.publicInvitationQr(token);
      res.setHeader('Content-Type', 'image/png');
      // The invitation page is served from another origin (the web app) and shows this card in an <img>; helmet's default
      // same-origin policy would make the browser refuse to display it. The token in the URL is the access control.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', 'inline; filename="entry-qr.png"');
      return res.status(200).send(png);
    } catch (error: any) {
      if (error.message === 'INVITATION_NOT_FOUND' || error.message === 'INVALID_TOKEN') {
        return res.status(404).json({ success: false, message: 'Invitation not found or token is invalid' });
      }
      if (error.message === 'CREDENTIAL_REPLACED') {
        return res.status(410).json({ success: false, code: 'CREDENTIAL_REPLACED', message: 'This access pass was replaced. Please use the new one we sent you.' });
      }
      if (error.message === 'CREDENTIAL_REVOKED') {
        return res.status(410).json({ success: false, code: 'CREDENTIAL_REVOKED', message: 'This access pass has been withdrawn and no longer works.' });
      }
      if (error.message === 'EVENT_CANCELLED') {
        return res.status(410).json({ success: false, code: 'EVENT_CANCELLED', message: 'This event has been cancelled. This access pass is no longer valid.' });
      }
      console.error('Request failed:', error?.message);
      return res.status(500).json({ success: false, message: 'Could not render the entry QR.' });
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
      if (unavailable(res, error)) return;
      console.error('Request failed:', error?.message);
      return res.status(500).json({ success: false, error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  async submitFoodPreference(req: Request, res: Response) {
    try {
      const data = await publicInvitationService.submitFoodPreference(req.params.token as string, req.body.dietarySelections);
      return res.status(200).json({ success: true, data });
    } catch (error: any) {
      const m = error.message;
      if (m === 'INVITATION_NOT_FOUND' || m === 'INVALID_TOKEN') return res.status(404).json({ success: false, error: 'Not Found', message: 'Invitation not found or token is invalid' });
      if (m === 'EVENT_CANCELLED') return res.status(410).json({ success: false, code: 'EVENT_CANCELLED', message: 'This event has been cancelled. Your response was not saved.' });
      if (m === 'RSVP_ENABLED') return res.status(400).json({ success: false, code: 'RSVP_ENABLED', message: 'Choose your answers when you accept the invitation.' });
      if (m === 'DIETARY_DISABLED') return res.status(400).json({ success: false, code: 'DIETARY_DISABLED', message: 'This event does not ask any questions.' });
      if (m === 'RSVP_CLOSED') return res.status(400).json({ success: false, message: 'This event has already ended.' });
      if (m === 'DIETARY_REQUIRED') return res.status(400).json({ success: false, code: 'DIETARY_REQUIRED', message: 'Please choose an option for every question.' });
      if (m === 'INVALID_DIETARY_PREFERENCE') return res.status(400).json({ success: false, message: 'Choose only from the dietary options provided for this event.' });
      if (unavailable(res, error)) return;
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
        return res.status(410).json({ success: false, code: 'EVENT_CANCELLED', message: 'This event has been cancelled. Your response was not saved.' });
      }
      if (error.message === 'RSVP_DISABLED') {
        return res.status(400).json({ success: false, message: 'RSVP is not open for this event.' });
      }
      if (error.message === 'RSVP_CLOSED') {
        return res.status(400).json({ success: false, message: 'The RSVP deadline for this event has passed.' });
      }
      if (error.message === 'DIETARY_NOT_ALLOWED_WHEN_DECLINED') {
        return res.status(400).json({ success: false, code: 'DIETARY_NOT_ALLOWED_WHEN_DECLINED', message: 'A food preference can only be given when you accept.' });
      }
      if (error.message === 'DIETARY_REQUIRED') {
        return res.status(400).json({ success: false, code: 'DIETARY_REQUIRED', message: 'Please choose an option for every question.' });
      }
      if (error.message === 'INVALID_DIETARY_PREFERENCE') {
        return res.status(400).json({ success: false, message: 'Choose only from the dietary options provided for this event.' });
      }
      if (unavailable(res, error)) return;
      console.error('Request failed:', error?.message);
      return res.status(500).json({ success: false, error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  }
};
