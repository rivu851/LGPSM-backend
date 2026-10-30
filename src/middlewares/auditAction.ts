import { Request, Response, NextFunction } from 'express';
import { auditLogService } from '../services/auditLog.service';
import { Invitee } from '../models/Invitee';
import { Session } from '../models/Session';
import { SystemUserAssignment } from '../models/SystemUserAssignment';

type EventOwner = 'Invitee' | 'Session' | 'SystemUserAssignment';
const OWNER_MODELS: Record<EventOwner, any> = { Invitee, Session, SystemUserAssignment };

export interface AuditActionOptions {
  action: string;
  entityType: string;
  /** req.params key holding the target entity id */
  entityParam?: string;
  /** req.params key holding the event id (otherwise body.eventId, the entity's own event, or the response) */
  eventParam?: string;
  /** Entity whose `eventId` should be looked up before the handler runs (needed for deletes) */
  eventOf?: EventOwner;
  /**
   * Fail closed: the PENDING entry is written before the handler runs; if it cannot be stored the request is refused,
   * so an irreversible action never happens without a record.
   */
  critical?: boolean;
  describe?: string;
  /** Extra safe fields taken from the request/response. Values are sanitised again before storage. */
  meta?: (req: Request, body: any) => Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object';

/**
 * Route-level audit trail. Mount after authenticate/authorizeRoles so the actor is known. It records who did what to
 * which entity and whether it worked (HTTP outcome), never request bodies: only the *names* of the fields that changed.
 */
export function auditAction(opts: AuditActionOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    const rid: string | undefined = (req as any).requestId;
    let captured: any;
    const json = res.json.bind(res);
    res.json = ((body: any) => { captured = body; return json(body); }) as any;

    const params = req.params as Record<string, string>;
    let entityId: unknown = opts.entityParam ? params[opts.entityParam] : undefined;
    let eventId: unknown = (opts.eventParam && params[opts.eventParam]) || (isObj(req.body) ? req.body.eventId : undefined);
    if (opts.eventOf && entityId && !eventId) {
      try {
        const row: any = await OWNER_MODELS[opts.eventOf].findById(entityId).select('eventId').lean();
        eventId = row?.eventId;
      } catch { /* an unknown id fails in the handler */ }
    }
    if (opts.entityType === 'Event' && !eventId) eventId = entityId;

    const baseMeta = () => ({
      method: req.method,
      route: `${req.baseUrl}${req.route?.path === '/' ? '' : req.route?.path || ''}`,
      changedFields: isObj(req.body) ? Object.keys(req.body).slice(0, 30) : []
    });
    const entry = (status: 'PENDING' | 'SUCCESS' | 'FAILED', organizerId: unknown) => ({
      actorId: user?.userId, actorRole: user?.role, eventId, organizerId, action: opts.action,
      entityType: opts.entityType, entityId, status, description: opts.describe, requestId: rid, metadata: baseMeta()
    });

    let organizerId: any = await auditLogService.organizerOfEvent(eventId).catch(() => undefined);
    // An organizer's own activity (e.g. managing their staff accounts) belongs to their tenant even without an event
    if (!organizerId && user?.role === 'ORGANIZER') organizerId = user.userId;
    let pendingId: unknown;

    if (opts.critical) {
      try {
        pendingId = (await auditLogService.logAction(entry('PENDING', organizerId)))._id;
      } catch (error: any) {
        console.error('Audit write failed, refusing critical action:', opts.action, error?.message);
        return res.status(503).json({ success: false, error: 'Service Unavailable', message: 'This action could not be recorded, so it was not performed. Please try again.' });
      }
    }

    res.on('finish', async () => {
      const ok = res.statusCode < 400;
      const data = isObj(captured) ? captured.data : undefined;
      entityId = entityId || (isObj(data) ? data._id || data.id || data.eventId : undefined);
      eventId = eventId || (isObj(data) ? data.eventId : undefined) || (opts.entityType === 'Event' ? entityId : undefined);
      if (!organizerId && eventId) organizerId = await auditLogService.organizerOfEvent(eventId).catch(() => undefined);
      if (!organizerId && user?.role === 'ORGANIZER') organizerId = user.userId;
      const metadata = { ...baseMeta(), httpStatus: res.statusCode, ...(opts.meta ? opts.meta(req, captured) : {}) };
      if (pendingId) {
        await auditLogService.finish(pendingId, { status: ok ? 'SUCCESS' : 'FAILED', eventId, organizerId, entityId, metadata });
      } else {
        await auditLogService.record({ ...entry(ok ? 'SUCCESS' : 'FAILED', organizerId), eventId, entityId, metadata });
      }
    });
    next();
  };
}
