import { Request, Response, NextFunction } from 'express';
import { checkInService, AdmissionError } from '../services/checkIn.service';

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

// Every refusal carries a machine-readable `code` the scanner can act on, and a message safe to show to staff: it never
// contains the pass, the guest's details or anything about other guests.
const REFUSALS: Record<string, { status: number; error: string; message: string }> = {
  EVENT_NOT_FOUND: { status: 404, error: 'Not Found', message: 'Event not found' },
  SESSION_NOT_FOUND: { status: 404, error: 'Not Found', message: 'Session not found for this event' },
  INVITEE_NOT_FOUND: { status: 404, error: 'Not Found', message: 'Invitee not found in this event' },
  EVENT_ID_REQUIRED: { status: 400, error: 'Bad Request', message: 'eventId is required' },
  EVENT_MISMATCH: { status: 400, error: 'Bad Request', message: 'QR token does not belong to the specified event' },
  SESSION_REQUIRED: { status: 400, error: 'Bad Request', message: 'Choose a session before checking guests in. You are assigned to specific sessions.' },
  RSVP_DECLINED: { status: 400, error: 'Bad Request', message: 'Check-in denied: Invitee RSVP is DECLINED' },
  RSVP_PENDING: { status: 400, error: 'Bad Request', message: 'Check-in denied: Invitee RSVP is PENDING and unconfirmed entry is disabled' },
  FORBIDDEN: { status: 403, error: 'Forbidden', message: 'You are not authorized for this event' },
  STAFF_EVENT_FORBIDDEN: { status: 403, error: 'Forbidden', message: 'You are not authorized for this event' },
  STAFF_SESSION_FORBIDDEN: { status: 403, error: 'Forbidden', message: 'Staff is not assigned to check in guests for this session' },
  INVITEE_SESSION_DENIED: { status: 403, error: 'Forbidden', message: 'Invitee does not have permission for this session' },
  EVENT_CANCELLED: { status: 409, error: 'Conflict', message: 'This event has been cancelled.' },
  EVENT_COMPLETED: { status: 409, error: 'Conflict', message: 'This event is already completed.' },
  EVENT_NOT_PUBLISHED: { status: 409, error: 'Conflict', message: 'This event is not open for check-in.' },
  CREDENTIAL_REVOKED: { status: 410, error: 'Gone', message: 'This access pass has been revoked.' },
  ONLY_ONCE_VIOLATION: { status: 409, error: 'Conflict', message: 'Invitee has already checked into this session (ONLY_ONCE rule)' },
  DUPLICATE_CHECKIN: { status: 409, error: 'Conflict', message: 'Invitee has already checked in' },
  PRIMARY_SESSION_CHECKIN_REQUIRED: { status: 409, error: 'Conflict', message: 'Guest must check in to the first session before entering this session' },
  CROSS_SESSION_CONFLICT: { status: 409, error: 'Conflict', message: 'Cross-session conflict: Invitee has already checked into another session for this event' },
};
const TIME_REFUSAL_STATUS: Record<string, { status: number; error: string }> = {
  ADMISSION_NOT_OPEN: { status: 409, error: 'Conflict' },
  SESSION_NOT_OPEN: { status: 409, error: 'Conflict' },
  ADMISSION_CLOSED: { status: 409, error: 'Conflict' },
  SESSION_CLOSED: { status: 409, error: 'Conflict' },
  CREDENTIAL_EXPIRED: { status: 410, error: 'Gone' },
};

/** Sends the refusal for a known check-in failure; returns false when the error is not one of them. */
function sendRefusal(res: Response, error: any): boolean {
  if (error instanceof AdmissionError) {
    const t = TIME_REFUSAL_STATUS[error.code];
    res.status(t.status).json({ success: false, code: error.code, error: t.error, message: error.describe(), opensAt: error.opensAt, closesAt: error.closesAt });
    return true;
  }
  const qr = QR_REJECTION_RESPONSES[error?.message as keyof typeof QR_REJECTION_RESPONSES];
  if (qr) {
    res.status(qr.status).json({ success: false, code: error.message, error: qr.error, message: qr.message });
    return true;
  }
  const code = error?.code === 11000 ? 'DUPLICATE_CHECKIN' : error?.message;
  const refusal = REFUSALS[code];
  if (refusal) {
    // The existing 'already checked in' wording is kept; the code makes it machine-readable (ALREADY_CHECKED_IN)
    res.status(refusal.status).json({ success: false, code: code === 'DUPLICATE_CHECKIN' ? 'ALREADY_CHECKED_IN' : code, error: refusal.error, message: refusal.message });
    return true;
  }
  return false;
}

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
      if (!sendRefusal(res, error)) next(error);
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
      if (!sendRefusal(res, error)) next(error);
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
