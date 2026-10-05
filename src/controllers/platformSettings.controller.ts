import { Request, Response, NextFunction } from 'express';
import { platformSettingsService } from '../services/platformSettings.service';
import { alertService } from '../services/alert.service';

export const platformSettingsController = {
  async getEventFeatures(_req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json({ success: true, data: await platformSettingsService.getEventFeatures() });
    } catch (error) {
      next(error);
    }
  },

  async updateEventFeatures(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json({ success: true, data: await platformSettingsService.updateEventFeatures(req.body) });
    } catch (error) {
      next(error);
    }
  },

  async getNotificationPreferences(_req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json({ success: true, data: await platformSettingsService.getNotificationPreferences() });
    } catch (error) {
      next(error);
    }
  },

  async updateNotificationPreferences(req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json({ success: true, data: await platformSettingsService.updateNotificationPreferences(req.body) });
    } catch (error) {
      next(error);
    }
  },

  async getPricing(_req: Request, res: Response, next: NextFunction) {
    try {
      res.status(200).json({ success: true, data: await platformSettingsService.getPricing() });
    } catch (error) {
      next(error);
    }
  },

  async updatePricing(req: Request, res: Response, next: NextFunction) {
    try {
      const before = (await platformSettingsService.getPricing()).ratePerInvitee;
      const data = await platformSettingsService.updateRate((req as any).user.userId, req.body.ratePerInvitee);
      if (before !== data.ratePerInvitee) {
        await alertService.notifyAdmins('changeInPrice', {
          type: 'BILLING',
          title: 'Price per invitee changed',
          message: `The rate changed from ${before === null ? 'not set' : `${data.currency} ${before}`} to ${data.currency} ${data.ratePerInvitee}. It applies to events created from now on.`
        });
      }
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }
};
