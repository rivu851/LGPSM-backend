import mongoose from 'mongoose';
import { AuditLog, IAuditLog } from '../models/AuditLog';

export interface AuditLogFilters {
  eventId?: string;
  actorId?: string;
  organizerId?: string;
  action?: string;
  page?: number;
  limit?: number;
}

export const auditLogRepository = {
  async create(data: Partial<IAuditLog>): Promise<IAuditLog> {
    return await AuditLog.create(data);
  },

  async finish(id: string, patch: { status: 'SUCCESS' | 'FAILED'; eventId?: mongoose.Types.ObjectId; organizerId?: mongoose.Types.ObjectId; entityId?: mongoose.Types.ObjectId; metadata?: Record<string, unknown> }) {
    const set: Record<string, unknown> = { status: patch.status };
    if (patch.eventId) set.eventId = patch.eventId;
    if (patch.organizerId) set.organizerId = patch.organizerId;
    if (patch.entityId) set.entityId = patch.entityId;
    if (patch.metadata) set.metadata = patch.metadata;
    await AuditLog.updateOne({ _id: id }, { $set: set });
  },

  async findLogs(filters: AuditLogFilters) {
    const query: any = {};
    if (filters.eventId) query.eventId = new mongoose.Types.ObjectId(filters.eventId);
    if (filters.actorId) query.actorId = new mongoose.Types.ObjectId(filters.actorId);
    if (filters.organizerId) query.organizerId = new mongoose.Types.ObjectId(filters.organizerId);
    if (filters.action) query.action = String(filters.action);

    const limit = Math.min(Math.max(filters.limit || 20, 1), 100);
    const page = Math.max(filters.page || 1, 1);
    const skip = (page - 1) * limit;

    const logs = await AuditLog.find(query)
      .populate('actorId', 'fullName email role')
      .populate('eventId', 'title')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await AuditLog.countDocuments(query);

    return { logs, total, page, totalPages: Math.ceil(total / limit) };
  }
};
