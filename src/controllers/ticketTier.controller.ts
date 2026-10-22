import { Request, Response } from 'express';
import { ticketTierService } from '../services/ticketTier.service';

export const ticketTierController = {
  async createTicketTier(req: Request, res: Response) {
    try {
      const eventId = req.params.eventId as string;
      const user = { userId: (req as any).user.userId, role: (req as any).user.role };
      const tier = await ticketTierService.createTicketTier(eventId, user, req.body);
      return res.status(201).json({ success: true, data: tier });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Event not found or access denied' });
      return res.status(400).json({ error: 'Bad Request', message: error.message });
    }
  },

  async getTicketTiers(req: Request, res: Response) {
    try {
      const eventId = req.params.eventId as string;
      const activeOnly = req.query.activeOnly !== 'false';
      const tiers = await ticketTierService.getTicketTiers(eventId, activeOnly);
      return res.status(200).json({ success: true, data: tiers });
    } catch (error: any) {
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  async updateTicketTier(req: Request, res: Response) {
    try {
      const user = { userId: (req as any).user.userId, role: (req as any).user.role };
      const tier = await ticketTierService.updateTicketTier(req.params.id as string, user, req.body);
      return res.status(200).json({ success: true, data: tier });
    } catch (error: any) {
      if (error.message === 'TICKET_TIER_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Ticket tier not found' });
      if (error.message === 'EVENT_NOT_FOUND') return res.status(403).json({ error: 'Forbidden', message: 'Access denied' });
      return res.status(400).json({ error: 'Bad Request', message: error.message });
    }
  },

  async deleteTicketTier(req: Request, res: Response) {
    try {
      const user = { userId: (req as any).user.userId, role: (req as any).user.role };
      const tier = await ticketTierService.deleteTicketTier(req.params.id as string, user);
      return res.status(200).json({ success: true, message: 'Ticket tier deactivated', data: tier });
    } catch (error: any) {
      if (error.message === 'TICKET_TIER_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Ticket tier not found' });
      if (error.message === 'EVENT_NOT_FOUND') return res.status(403).json({ error: 'Forbidden', message: 'Access denied' });
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  }
};
