import mongoose, { Document, Schema } from 'mongoose';

export interface IAuditLog extends Document {
  actorId: mongoose.Types.ObjectId;
  actorType: 'ADMIN' | 'ORGANIZER' | 'SYSTEM_USER';
  eventId?: mongoose.Types.ObjectId;
  action: string;
  entityType?: string;
  entityId?: mongoose.Types.ObjectId;
  // Tenant that owns the audited event; organizers can only read entries with their own id here
  organizerId?: mongoose.Types.ObjectId;
  // PENDING = intent recorded before a critical operation ran; it is moved to SUCCESS/FAILED when the operation ends
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  description?: string;
  requestId?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const AuditLogSchema: Schema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorType: { type: String, enum: ['ADMIN', 'ORGANIZER', 'SYSTEM_USER'], required: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event' },
    action: { type: String, required: true },
    entityType: { type: String },
    entityId: { type: Schema.Types.ObjectId },
    organizerId: { type: Schema.Types.ObjectId, ref: 'User' },
    status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED'], default: 'SUCCESS' },
    description: { type: String, maxlength: 300 },
    requestId: { type: String, maxlength: 100 },
    metadata: { type: Schema.Types.Mixed, default: {} }
  },
  {
    timestamps: { createdAt: true, updatedAt: false }
  }
);

AuditLogSchema.index({ actorId: 1 });
AuditLogSchema.index({ eventId: 1 });
AuditLogSchema.index({ action: 1 });
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ organizerId: 1, createdAt: -1 });
AuditLogSchema.index({ eventId: 1, createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
