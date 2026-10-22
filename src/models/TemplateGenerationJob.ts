import mongoose, { Document, Schema } from 'mongoose';

// One AI template-generation request and its outcome. Persisted so a request survives a page reload or a restart,
// can be polled by web and mobile, and can never stay "running" forever (see leaseExpiresAt and the recovery in
// templateGeneration.service.ts). Jobs delete themselves after a week (TTL on expiresAt).

export const JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'CONCEPT_ONLY', 'FAILED'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JOB_MODES = ['CREATE', 'EDIT', 'VARIATIONS'] as const;
export type JobMode = (typeof JOB_MODES)[number];

export interface IJobVariant {
  index: number;
  /** Provider references, kept so a variant can be edited or varied later; never returned to clients */
  projectId: string;
  screenId: string;
  /** Re-encoded screenshot of the generated concept (media:<id>): what the provider drew */
  conceptImageKey?: string;
  /** The converted template drawn with sample details (media:<id>): what the LGPSM renderer will produce */
  previewImageKey?: string;
  /** true only when the concept was converted into a valid, render-checked design */
  ready: boolean;
  fidelity: 'STYLE_ADAPTED' | 'NONE';
  notes: string[];
  designSpec?: Record<string, any>;
  templateId?: mongoose.Types.ObjectId;
}

export interface ITemplateGenerationJob extends Document {
  ownerId: mongoose.Types.ObjectId;
  kind: 'INVITATION' | 'POSTER';
  preset: string;
  mode: JobMode;
  prompt: string;
  promptHash: string;
  style: { mood?: string; colorHint?: string };
  variantCount: number;
  parentJobId?: mongoose.Types.ObjectId;
  parentVariantIndex?: number;
  status: JobStatus;
  error?: { code: string; message: string };
  variants: IJobVariant[];
  idempotencyKey?: string;
  startedAt?: Date;
  finishedAt?: Date;
  leaseExpiresAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const VariantSchema = new Schema<IJobVariant>(
  {
    index: { type: Number, required: true },
    projectId: { type: String, required: true },
    screenId: { type: String, required: true },
    conceptImageKey: String,
    previewImageKey: String,
    ready: { type: Boolean, required: true },
    fidelity: { type: String, enum: ['STYLE_ADAPTED', 'NONE'], default: 'NONE' },
    notes: [String],
    designSpec: Schema.Types.Mixed,
    templateId: { type: Schema.Types.ObjectId, ref: 'Template' }
  },
  { _id: false }
);

const JobSchema = new Schema<ITemplateGenerationJob>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['INVITATION', 'POSTER'], required: true },
    preset: { type: String, required: true },
    mode: { type: String, enum: JOB_MODES, default: 'CREATE' },
    prompt: { type: String, required: true, maxlength: 1200 },
    promptHash: { type: String, required: true },
    style: { mood: String, colorHint: String },
    variantCount: { type: Number, default: 1, min: 1, max: 3 },
    parentJobId: { type: Schema.Types.ObjectId, ref: 'TemplateGenerationJob' },
    parentVariantIndex: Number,
    status: { type: String, enum: JOB_STATUSES, default: 'QUEUED', index: true },
    error: { type: new Schema({ code: String, message: String }, { _id: false }) },
    variants: { type: [VariantSchema], default: [] },
    idempotencyKey: { type: String, maxlength: 80 },
    startedAt: Date,
    finishedAt: Date,
    leaseExpiresAt: Date,
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true }
);

JobSchema.index({ ownerId: 1, createdAt: -1 });
JobSchema.index({ ownerId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
JobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const TemplateGenerationJob = mongoose.model<ITemplateGenerationJob>('TemplateGenerationJob', JobSchema);
