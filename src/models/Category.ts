import mongoose, { Document, Schema } from 'mongoose';

export interface ISubcategory {
  _id?: mongoose.Types.ObjectId;
  name: string;
  isActive: boolean;
  /** set for a subcategory an organizer made for themselves; only that organizer sees or can use it */
  ownerId?: mongoose.Types.ObjectId;
}

export interface ICategory extends Document {
  name: string;
  description?: string;
  subcategories: ISubcategory[];
  isActive: boolean;
  /** set for a category an organizer made for themselves; absent for the platform's own list */
  ownerId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const SubcategorySchema = new Schema(
  {
    name: { type: String, required: true },
    isActive: { type: Boolean, default: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

const CategorySchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    description: { type: String },
    subcategories: { type: [SubcategorySchema], default: [] },
    isActive: { type: Boolean, default: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  {
    timestamps: true
  }
);

// A name is unique across the platform's own list, and unique per organizer among their own custom categories.
// (Databases created before custom categories hold a plain unique index on name: scripts/migrate-category-uniqueness.js replaces it.)
CategorySchema.index({ name: 1 }, { unique: true, partialFilterExpression: { ownerId: { $exists: false } }, name: 'name_platform_unique' });
CategorySchema.index({ ownerId: 1, name: 1 }, { unique: true, partialFilterExpression: { ownerId: { $exists: true } }, name: 'owner_name_unique' });

export const Category = mongoose.model<ICategory>('Category', CategorySchema);
