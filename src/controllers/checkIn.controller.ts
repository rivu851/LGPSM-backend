import { Request, Response, NextFunction } from 'express';
import { checkInService } from '../services/checkIn.service';

// QR problems carry a machine-readable `code` so the client can tell an unreadable pass from an
// unknown one and from a business-rule denial.
const QR_REJECTION_RESPONSES = {
  QR_PAYLOAD_REQUIRED: { status: 400, error: 'Bad Request', message: 'Scan or upload a QR pass first' },
  QR_FORMAT_UNSUPPORTED: { status: 400, error: 'Bad Request', message: 'This QR code is not an LGPSM invitation pass' },
  QR_URL_UNTRUSTED: { status: 400, error: 'Bad Request', message: 'This QR code links to an address that is not an LGPSM invitation' },
  QR_PREVIEW_SAMPLE: { status: 400, error: 'Bad Request', message: 'This is a sample QR from a card preview. Send the invitation to issue the guest a real pass' },
  QR_TOKEN_SUPERSEDED: { status: 410, error: 'Gone', message: 'This pass was replaced by a newer invitation. Ask the guest for the latest one' },
  INVALID_QR_TOKEN: { status: 404, error: 'Not Found', message: 'No invitation matches this QR pass' },
} as const;

export const checkInController = {
  async scanCheckIn(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = {
        userId: (req as any).user.userId,
        role: (req as any).user.role
      };

      const result = await checkInService.scanCheckIn(actor, req.body);
      res.status(201).json({ success: true, message: 'Check-in successful', data: result });
    } catch (error: any) {
      const qrRejection = QR_REJECTION_RESPONSES[error.message as keyof typeof QR_REJECTION_RESPONSES];
      if (qrRejection) {
        res.status(qrRejection.status).json({ success: false, code: error.message, error: qrRejection.error, message: qrRejection.message });
      } else if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ success: false, error: 'Not Found', message: 'Event not found' });
      } else if (error.message === 'SESSION_NOT_FOUND') {
        res.status(404).json({ success: false, error: 'Not Found', message: 'Session not found for this event' });
      } else if (error.message === 'EVENT_MISMATCH') {
        res.status(400).json({ success: false, error: 'Bad Request', message: 'QR token does not belong to the specified event' });
      } else if (error.message === 'RSVP_DECLINED') {
        res.status(400).json({ success: false, error: 'Bad Request', message: 'Check-in denied: Invitee RSVP is DECLINED' });
      } else if (error.message === 'RSVP_PENDING') {
        res.status(400).json({ success: false, error: 'Bad Request', message: 'Check-in denied: Invitee RSVP is PENDING and unconfirmed entry is disabled' });
      } else if (error.message === 'FORBIDDEN' || error.message === 'STAFF_EVENT_FORBIDDEN') {
        res.status(403).json({ success: false, error: 'Forbidden', message: 'You are not authorized for this event' });
      } else if (error.message === 'STAFF_SESSION_FORBIDDEN') {
        res.status(403).json({ success: false, error: 'Forbidden', message: 'Staff is not assigned to check in guests for this session' });
      } else if (error.message === 'INVITEE_SESSION_DENIED') {
        res.status(403).json({ success: false, error: 'Forbidden', message: 'Invitee does not have permission for this session' });
      } else if (error.message === 'ONLY_ONCE_VIOLATION') {
        res.status(409).json({ success: false, error: 'Conflict', message: 'Invitee has already checked into this session (ONLY_ONCE rule)' });
      } else if (error.message === 'DUPLICATE_CHECKIN' || error.code === 11000) {
        res.status(409).json({ success: false, error: 'Conflict', message: 'Invitee has already checked in' });
      } else if (error.message === 'PRIMARY_SESSION_CHECKIN_REQUIRED') {
        res.status(409).json({ success: false, error: 'Conflict', message: 'Guest must check in to the first session before entering this session' });
      } else if (error.message === 'CROSS_SESSION_CONFLICT') {
        res.status(409).json({ success: false, error: 'Conflict', message: 'Cross-session conflict: Invitee has already checked into another session for this event' });
      } else {
        next(error);
      }
    }
  },

  async manualCheckIn(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = {
        userId: (req as any).user.userId,
        role: (req as any).user.role
      };

      const result = await checkInService.manualCheckIn(actor, req.body);
      res.status(201).json({ success: true, message: 'Check-in successful', data: result });
    } catch (error: any) {
      if (error.message === 'INVITEE_NOT_FOUND') {
        res.status(404).json({ success: false, error: 'Not Found', message: 'Invitee not found in this event' });
      } else if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ success: false, error: 'Not Found', message: 'Event not found' });
      } else if (error.message === 'SESSION_NOT_FOUND') {
        res.status(404).json({ success: false, error: 'Not Found', message: 'Session not found for this event' });
      } else if (error.message === 'EVENT_ID_REQUIRED') {
        res.status(400).json({ success: false, error: 'Bad Request', message: 'eventId is required' });
      } else if (error.message === 'RSVP_DECLINED') {
        res.status(400).json({ success: false, error: 'Bad Request', message: 'Check-in denied: Invitee RSVP is DECLINED' });
      } else if (error.message === 'RSVP_PENDING') {
        res.status(400).json({ success: false, error: 'Bad Request', message: 'Check-in denied: Invitee RSVP is PENDING and unconfirmed entry is disabled' });
      } else if (error.message === 'FORBIDDEN' || error.message === 'STAFF_EVENT_FORBIDDEN') {
        res.status(403).json({ success: false, error: 'Forbidden', message: 'You are not authorized for this event' });
      } else if (error.message === 'STAFF_SESSION_FORBIDDEN') {
        res.status(403).json({ success: false, error: 'Forbidden', message: 'Staff is not assigned to check in guests for this session' });
      } else if (error.message === 'INVITEE_SESSION_DENIED') {
        res.status(403).json({ success: false, error: 'Forbidden', message: 'Invitee does not have permission for this session' });
      } else if (error.message === 'ONLY_ONCE_VIOLATION') {
        res.status(409).json({ success: false, error: 'Conflict', message: 'Invitee has already checked into this session (ONLY_ONCE rule)' });
      } else if (error.message === 'DUPLICATE_CHECKIN' || error.code === 11000) {
        res.status(409).json({ success: false, error: 'Conflict', message: 'Invitee has already checked in' });
      } else if (error.message === 'PRIMARY_SESSION_CHECKIN_REQUIRED') {
        res.status(409).json({ success: false, error: 'Conflict', message: 'Guest must check in to the first session before entering this session' });
      } else if (error.message === 'CROSS_SESSION_CONFLICT') {
        res.status(409).json({ success: false, error: 'Conflict', message: 'Cross-session conflict: Invitee has already checked into another session for this event' });
      } else {
        next(error);
      }
    }
  },

  async getCheckIns(req: Request, res: Response, next: NextFunction) {
    try {
      const actor = {
        userId: (req as any).user.userId,
        role: (req as any).user.role
      };
      const eventId = req.params.eventId as string;

      const options = {
        sessionId: req.query.sessionId as string,
        checkInMethod: req.query.checkInMethod as string,
        page: req.query.page ? parseInt(req.query.page as string) : 1,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 20
      };

      const result = await checkInService.getCheckIns(actor, eventId, options);
      res.status(200).json({
        success: true,
        data: result.checkIns,
        meta: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: result.totalPages
        }
      });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ success: false, error: 'Not Found', message: 'Event not found' });
      } else if (error.message === 'FORBIDDEN' || error.message === 'STAFF_EVENT_FORBIDDEN') {
        res.status(403).json({ success: false, error: 'Forbidden', message: 'You are not authorized for this event' });
      } else if (error.message === 'STAFF_SESSION_FORBIDDEN') {
        res.status(403).json({ success: false, error: 'Forbidden', message: 'Staff is not authorized to retrieve logs for this session' });
      } else {
        next(error);
      }
    }
  }
};
