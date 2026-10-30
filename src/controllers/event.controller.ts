import { Request, Response, NextFunction } from 'express';
import { cancellationNoticeService } from '../services/cancellationNotice.service';
import { eventService } from '../services/event.service';
import { EventStatus } from '../models/Event';
import { Role } from '../models/User';

export const eventController = {
  async createEvent(req: Request, res: Response, next: NextFunction) {
    try {
      const authUser = (req as any).user;
      const userRole = authUser.role;

      if (userRole === Role.ADMIN || userRole === 'SUPER_ADMIN') {
        const organizerIds = Array.isArray(req.body.organizerIds) && req.body.organizerIds.length > 0
          ? req.body.organizerIds
          : req.body.organizerId
            ? [req.body.organizerId]
            : null;

        if (organizerIds && organizerIds.length > 0) {
          const eventsCreated = [];
          for (const orgId of organizerIds) {
            const event = await eventService.createEvent(orgId, { ...req.body, organizerId: orgId });
            eventsCreated.push(event);
          }
          const primaryEvent = eventsCreated[0];
          res.status(201).json({
            success: true,
            data: {
              eventId: (primaryEvent as any)._id.toString(),
              eventIds: eventsCreated.map((e: any) => (e as any)._id.toString()),
              status: primaryEvent.status.toLowerCase(),
              createdAt: primaryEvent.createdAt
            }
          });
          return;
        }
      }

      const organizerId = authUser.userId;
      const event = await eventService.createEvent(organizerId, req.body);
      
      res.status(201).json({
        success: true,
        data: {
          eventId: (event as any)._id.toString(),
          status: event.status.toLowerCase(),
          createdAt: event.createdAt
        }
      });
    } catch (error) {
      next(error);
    }
  },

  async getEvents(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const requestedOrganizer = req.query.organizerId as string | undefined;
      if (requestedOrganizer && !/^[0-9a-fA-F]{24}$/.test(requestedOrganizer)) {
        res.status(400).json({ success: false, message: 'Invalid organizerId format' });
        return;
      }
      const filter = {
        status: req.query.status as EventStatus,
        categoryId: req.query.categoryId as string,
        organizerId: requestedOrganizer
      };

      const result = await eventService.getEventsByOrganizer(organizerId, filter, { page, limit }, (req as any).user.role);
      
      res.status(200).json({
        success: true,
        data: result.events,
        meta: {
          page,
          limit,
          total: result.total
        }
      });
    } catch (error) {
      next(error);
    }
  },

  async getEventById(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const eventId = req.params.eventId as string;
      
      const event = await eventService.getEventDetails(eventId, organizerId, (req as any).user.role);
      
      res.status(200).json({ success: true, data: event });
    } catch (error) {
      if ((error as Error).message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else {
        next(error);
      }
    }
  },

  async updateEvent(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const eventId = req.params.eventId as string;
      
      const event = await eventService.updateEvent(eventId, organizerId, req.body, (req as any).user.role);
      
      res.status(200).json({ success: true, data: event });
    } catch (error) {
       if ((error as Error).message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else if ((error as Error).message === 'EVENT_CLOSED') {
        res.status(409).json({ success: false, error: 'Conflict', code: 'EVENT_CLOSED', message: 'A closed or cancelled event can no longer be edited.' });
      } else if ((error as Error).message === 'EVENT_LOCKED') {
        res.status(409).json({ success: false, error: 'Conflict', code: 'EVENT_LOCKED', message: 'This event can’t be edited after invitations have been sent.', details: [] });
      } else if ((error as Error).message === 'CATEGORY_NOT_FOUND' || (error as Error).message === 'TEMPLATE_NOT_FOUND') {
        res.status(400).json({ success: false, error: 'Bad Request', message: (error as Error).message === 'CATEGORY_NOT_FOUND' ? 'Selected category does not exist' : 'Selected template does not exist', details: [] });
      } else {
        next(error);
      }
    }
  },

  /**
   * Cancels the event (terminal). `DELETE /events/:id` is kept for older clients and means exactly the same as
   * `POST /events/:id/cancel`: an event is never deleted by it.
   */
  async cancelEvent(req: Request, res: Response, next: NextFunction) {
    try {
      const { event, alreadyCancelled, notices } = await eventService.cancelEvent(
        req.params.eventId as string,
        { userId: (req as any).user.userId, role: (req as any).user.role },
        typeof req.body?.reason === 'string' ? req.body.reason : undefined
      );
      res.status(200).json({
        success: true,
        data: { eventId: (event as any)._id, status: event.status, cancelledAt: (event as any).cancelledAt, alreadyCancelled, notices }
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else if (message === 'INVALID_TRANSITION') {
        res.status(409).json({ success: false, error: 'Conflict', code: 'INVALID_TRANSITION', message: 'A completed or closed event cannot be cancelled.' });
      } else if (message === 'FORBIDDEN') {
        res.status(403).json({ success: false, error: 'Forbidden', message: 'You are not authorized to cancel this event' });
      } else {
        next(error);
      }
    }
  },

  async getCancellationPreview(req: Request, res: Response, next: NextFunction) {
    try {
      const event = await eventService.findForNotices(req.params.eventId as string, (req as any).user);
      res.status(200).json({ success: true, data: await cancellationNoticeService.preview(event._id) });
    } catch (error) { sendNoticeError(res, next, error); }
  },

  async getCancellationNotices(req: Request, res: Response, next: NextFunction) {
    try {
      const event = await eventService.findForNotices(req.params.eventId as string, (req as any).user);
      res.status(200).json({ success: true, data: { cancelledAt: (event as any).cancelledAt, reason: (event as any).cancellationReason, ...(await cancellationNoticeService.summary(event._id)) } });
    } catch (error) { sendNoticeError(res, next, error); }
  },

  async retryCancellationNotices(req: Request, res: Response, next: NextFunction) {
    try {
      const event = await eventService.findForNotices(req.params.eventId as string, (req as any).user);
      if (event.status !== 'CANCELLED') return res.status(409).json({ success: false, error: 'Conflict', code: 'EVENT_NOT_CANCELLED', message: 'Only a cancelled event has cancellation notices.' });
      // fill in anything missing (idempotent), then retry failed/unavailable channels; the response reports what was attempted
      await cancellationNoticeService.enqueueForEvent(event);
      const attempted = await cancellationNoticeService.processEvent(event._id, { retry: true });
      res.status(200).json({ success: true, data: { attempted, ...(await cancellationNoticeService.summary(event._id)) } });
    } catch (error) { sendNoticeError(res, next, error); }
  },

  async updateAdmission(req: Request, res: Response, next: NextFunction) {
    try {
      const event = await eventService.updateAdmission(req.params.eventId as string, { userId: (req as any).user.userId, role: (req as any).user.role }, req.body);
      res.status(200).json({ success: true, data: event });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else if (error.message === 'EVENT_CLOSED') {
        res.status(409).json({ success: false, error: 'Conflict', code: 'EVENT_CLOSED', message: 'The check-in window of a closed or cancelled event can no longer be changed.' });
      } else if (error.statusCode === 400) {
        res.status(400).json({ success: false, error: 'Bad Request', message: error.message });
      } else {
        next(error);
      }
    }
  },

  async closeEvent(req: Request, res: Response, next: NextFunction) {
    try {
      const event = await eventService.closeEvent(req.params.eventId as string, { userId: (req as any).user.userId, role: (req as any).user.role });
      res.status(200).json({ success: true, data: event });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else if (error.message === 'INVALID_TRANSITION') {
        res.status(409).json({ success: false, error: 'Conflict', code: 'INVALID_TRANSITION', message: 'Only a published event can be closed.' });
      } else {
        next(error);
      }
    }
  },

  async cleanupEventData(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = {
        userId: (req as any).user.userId,
        role: (req as any).user.role
      };
      const eventId = req.params.eventId as string;

      const result = await eventService.cleanupEventOperationalData(eventId, actor, typeof req.body?.confirmTitle === 'string' ? req.body.confirmTitle : undefined);
      res.status(200).json({
        success: true,
        message: result.alreadyCleared
          ? 'Operational data has already been cleared for this event'
          : 'Event operational data successfully cleared',
        data: result.event,
        cleanedCounts: result.cleanedCounts
      });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ success: false, error: 'Not Found', message: 'Event not found' });
      } else if (error.message === 'FORBIDDEN_CLEANUP') {
        res.status(403).json({ success: false, error: 'Forbidden', message: 'Only authorized ADMIN can perform event operational data cleanup' });
      } else if (error.message === 'EVENT_NOT_CLOSED') {
        res.status(409).json({ success: false, error: 'Conflict', code: 'EVENT_NOT_CLOSED', message: 'Close the event first. Permanent deletion is only available for closed events.' });
      } else if (error.message === 'CONFIRMATION_REQUIRED') {
        res.status(400).json({ success: false, error: 'Bad Request', code: 'CONFIRMATION_REQUIRED', message: 'Type the event title exactly to confirm permanent deletion.' });
      } else {
        next(error);
      }
    }
  }
};

function sendNoticeError(res: Response, next: NextFunction, error: unknown) {
  if ((error as Error).message === 'EVENT_NOT_FOUND') {
    res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
  } else if ((error as Error).message === 'FORBIDDEN') {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'You are not authorized for this event' });
  } else {
    next(error);
  }
}
