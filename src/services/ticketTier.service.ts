import { ticketTierRepository } from '../repositories/ticketTier.repository';
import { Event } from '../models/Event';
import { ITicketTier } from '../models/TicketTier';
import { Role } from '../models/User';

export const ticketTierService = {
  async createTicketTier(eventId: string, user: { userId: string; role: string }, data: Partial<ITicketTier>): Promise<ITicketTier> {
    const isOrganizer = user.role !== Role.ADMIN && user.role !== 'ADMIN';
    const event = isOrganizer
      ? await Event.findOne({ _id: eventId, organizerId: user.userId })
      : await Event.findById(eventId);

    if (!event) throw new Error('EVENT_NOT_FOUND');

    return await ticketTierRepository.create({ ...data, eventId: event._id as any });
  },

  /** Price, capacity and sales of an event belong to its organizer (and the admin): anyone else is told the event does not exist. */
  async getTicketTiers(eventId: string, user: { userId: string; role: string }, activeOnly: boolean = true): Promise<ITicketTier[]> {
    const isOrganizer = user.role !== Role.ADMIN && user.role !== 'ADMIN';
    const event = isOrganizer
      ? await Event.findOne({ _id: eventId, organizerId: user.userId }).select('_id')
      : await Event.findById(eventId).select('_id');
    if (!event) throw new Error('EVENT_NOT_FOUND');
    return await ticketTierRepository.findByEventId(eventId, activeOnly);
  },

  async updateTicketTier(id: string, user: { userId: string; role: string }, updateData: Partial<ITicketTier>): Promise<ITicketTier> {
    const tier = await ticketTierRepository.findById(id);
    if (!tier) throw new Error('TICKET_TIER_NOT_FOUND');

    const isOrganizer = user.role !== Role.ADMIN && user.role !== 'ADMIN';
    if (isOrganizer) {
      const event = await Event.findOne({ _id: tier.eventId, organizerId: user.userId });
      if (!event) throw new Error('EVENT_NOT_FOUND');
    }

    const updated = await ticketTierRepository.update(id, updateData);
    return updated!;
  },

  async deleteTicketTier(id: string, user: { userId: string; role: string }): Promise<ITicketTier> {
    const tier = await ticketTierRepository.findById(id);
    if (!tier) throw new Error('TICKET_TIER_NOT_FOUND');

    const isOrganizer = user.role !== Role.ADMIN && user.role !== 'ADMIN';
    if (isOrganizer) {
      const event = await Event.findOne({ _id: tier.eventId, organizerId: user.userId });
      if (!event) throw new Error('EVENT_NOT_FOUND');
    }

    const deleted = await ticketTierRepository.delete(id);
    return deleted!;
  }
};
