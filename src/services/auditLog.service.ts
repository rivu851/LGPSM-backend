import mongoose from 'mongoose';
import { auditLogRepository, AuditLogFilters } from '../repositories/auditLog.repository';
import { IAuditLog } from '../models/AuditLog';
import { Event } from '../models/Event';
import { Role } from '../models/User';
import { sanitizeAuditMetadata } from '../utils/auditSanitize';

export interface AuditEntry {
  actorId?: unknown;
  actorRole?: unknown;
  eventId?: unknown;
  organizerId?: unknown;
  action: string;
  entityType?: string;
  entityId?: unknown;
  status?: 'PENDING' | 'SUCCESS' | 'FAILED';
  description?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

const ROLES = new Set<string>([Role.ADMIN, Role.ORGANIZER, Role.SYSTEM_USER]);
const asId = (v: unknown) => (v && mongoose.Types.ObjectId.isValid(String(v)) ? new mongoose.Types.ObjectId(String(v)) : undefined);

function toDoc(entry: AuditEntry): Partial<IAuditLog> | null {
  const actorId = asId(entry.actorId);
  const role = String(entry.actorRole || '');
  // An entry without a real actor is not evidence of anything; refuse to write it
  if (!actorId || !ROLES.has(role) || !entry.action) return null;
  return {
    actorId,
    actorType: role as IAuditLog['actorType'],
    eventId: asId(entry.eventId),
    organizerId: asId(entry.organizerId),
    action: entry.action,
    entityType: entry.entityType,
    entityId: asId(entry.entityId),
    status: entry.status || 'SUCCESS',
    description: entry.description?.slice(0, 300),
    requestId: entry.requestId,
    metadata: sanitizeAuditMetadata(entry.metadata)
  };
}

export const auditLogService = {
  /** Strict write: throws if the entry is invalid or cannot be stored. Used where the caller must fail closed. */
  async logAction(entry: AuditEntry): Promise<IAuditLog> {
    const doc = toDoc(entry);
    if (!doc) throw new Error('AUDIT_INVALID_ACTOR');
    return auditLogRepository.create(doc);
  },

  /** Best-effort write for non-critical actions: a failure is reported on the server log but never breaks the request. */
  async record(entry: AuditEntry): Promise<IAuditLog | null> {
    try {
      return await this.logAction(entry);
    } catch (error: any) {
      console.error('Audit write failed:', entry.action, error?.message);
      return null;
    }
  },

  /** The tenant that owns an event, so entries can be isolated per organizer. */
  async organizerOfEvent(eventId: unknown): Promise<mongoose.Types.ObjectId | undefined> {
    const id = asId(eventId);
    if (!id) return undefined;
    const ev: any = await Event.findById(id).select('organizerId').lean();
    return ev?.organizerId;
  },

  async finish(id: unknown, patch: { status: 'SUCCESS' | 'FAILED'; eventId?: unknown; organizerId?: unknown; entityId?: unknown; metadata?: Record<string, unknown> }) {
    try {
      await auditLogRepository.finish(String(id), {
        status: patch.status,
        eventId: asId(patch.eventId),
        organizerId: asId(patch.organizerId),
        entityId: asId(patch.entityId),
        metadata: patch.metadata ? sanitizeAuditMetadata(patch.metadata) : undefined
      });
    } catch (error: any) {
      // The PENDING entry still proves the attempt happened
      console.error('Audit completion failed:', error?.message);
    }
  },

  /**
   * Role-scoped read. Isolation is decided here on the server and cannot be widened by query parameters:
   * an organizer is always pinned to their own tenant; an admin sees the platform.
   */
  async getLogs(actor: { userId: string; role: string }, query: { eventId?: string; actorId?: string; action?: string; page?: number; limit?: number }) {
    const filters: AuditLogFilters = { action: query.action, page: query.page, limit: query.limit };
    if (query.eventId) {
      if (!asId(query.eventId)) throw new Error('INVALID_ID');
      filters.eventId = query.eventId;
    }
    if (query.actorId) {
      if (!asId(query.actorId)) throw new Error('INVALID_ID');
      filters.actorId = query.actorId;
    }
    if (actor.role === Role.ADMIN) return auditLogRepository.findLogs(filters);
    if (actor.role === Role.ORGANIZER) return auditLogRepository.findLogs({ ...filters, organizerId: actor.userId });
    throw new Error('FORBIDDEN');
  }
};
