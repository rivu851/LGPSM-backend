import mongoose, { Document, Schema } from 'mongoose';

export const CARD_DESIGNS = [
  'CLASSIC',
  'CORPORATE_V1',
  'CORPORATE_V2',
  'WEDDING',
  'RICE_CEREMONY',
  'BIRTHDAY',
  // Rendered from `designSpec` (see services/cardTemplates/designSpec.ts) instead of fixed Figma artwork
  'CUSTOM'
] as const;
export type CardDesign = (typeof CARD_DESIGNS)[number];

export const TEMPLATE_KINDS = ['INVITATION', 'POSTER'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export interface ITemplate extends Document {
  name: string;
  categoryId?: mongoose.Types.ObjectId;
  subcategoryId?: mongoose.Types.ObjectId;
  previewImageKey?: string;
  templateData?: Record<string, any>;
  cardDesign: CardDesign;
  kind: TemplateKind;
  /** Organizer (or admin) who created an AI template; absent on the designers' system templates */
  ownerId?: mongoose.Types.ObjectId;
  /** Validated, versioned design for cardDesign CUSTOM; never contains markup, scripts or URLs */
  designSpec?: Record<string, any>;
  source?: { provider: 'STITCH'; jobId?: mongoose.Types.ObjectId; screenId?: string };
  isSystemTemplate: boolean;
  isPublished: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TemplateSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
    subcategoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
    previewImageKey: { type: String },
    templateData: { type: Schema.Types.Mixed, default: {} },
    cardDesign: { type: String, enum: CARD_DESIGNS, default: 'CLASSIC' },
    kind: { type: String, enum: TEMPLATE_KINDS, default: 'INVITATION' },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    designSpec: { type: Schema.Types.Mixed },
    source: {
      type: new Schema({ provider: { type: String, enum: ['STITCH'] }, jobId: { type: Schema.Types.ObjectId }, screenId: { type: String } }, { _id: false })
    },
    isSystemTemplate: { type: Boolean, default: true },
    // Drafts are visible to admins only; organizers can pick published templates
    isPublished: { type: Boolean, default: true },
    // false = deleted (soft delete)
    isActive: { type: Boolean, default: true }
  },
  {
    timestamps: true
  }
);

export const Template = mongoose.model<ITemplate>('Template', TemplateSchema);
