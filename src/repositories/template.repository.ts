import mongoose from 'mongoose';
import { Template, ITemplate } from '../models/Template';

/**
 * Who is asking, for visibility. Admins see every template (drafts included); an organizer sees the published
 * templates that have no owner (the designers' and admin-published ones) plus their own, whatever their state.
 */
export interface TemplateViewer {
  userId?: string;
  isAdmin: boolean;
}

export interface TemplateListOptions {
  skip?: number;
  limit?: number;
  /** only the viewer's own templates, drafts included (the "My templates" list) */
  mineOnly?: boolean;
  kind?: 'INVITATION' | 'POSTER';
}

function listQuery(categoryId: string | undefined, viewer: TemplateViewer, options: TemplateListOptions) {
  const query: any = { isActive: true };
  if (categoryId) query.categoryId = categoryId;
  if (options.kind) query.kind = options.kind === 'INVITATION' ? { $in: ['INVITATION', null] } : 'POSTER';
  const own = viewer.userId && mongoose.Types.ObjectId.isValid(viewer.userId) ? { ownerId: new mongoose.Types.ObjectId(viewer.userId) } : null;
  if (options.mineOnly) {
    query.ownerId = own?.ownerId ?? { $exists: false, $eq: null };
    return query;
  }
  if (!viewer.isAdmin) {
    // Templates created before the publish flag existed count as published. A template with an owner is a private
    // AI design unless an admin published it as a system template, so another organizer's never appears.
    const visible: any[] = [{ ownerId: { $exists: false }, isPublished: { $ne: false } }, { isSystemTemplate: true, isPublished: true }];
    // the owner's published templates are offered for their events; drafts live in the "mine" list until published
    if (own) visible.push({ ...own, isPublished: true });
    query.$or = visible;
  }
  return query;
}

export const templateRepository = {
  async create(data: Partial<ITemplate>): Promise<ITemplate> {
    return await Template.create(data);
  },

  async findAll(categoryId: string | undefined, viewer: TemplateViewer, options: TemplateListOptions = {}): Promise<ITemplate[]> {
    let cursor = Template.find(listQuery(categoryId, viewer, options)).populate('categoryId').sort({ createdAt: -1, _id: -1 });
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    return await cursor;
  },

  async count(categoryId: string | undefined, viewer: TemplateViewer, options: TemplateListOptions = {}): Promise<number> {
    return await Template.countDocuments(listQuery(categoryId, viewer, options));
  },

  async findById(id: string): Promise<ITemplate | null> {
    return await Template.findById(id).populate('categoryId');
  },

  async update(id: string, updateData: Partial<ITemplate>): Promise<ITemplate | null> {
    return await Template.findByIdAndUpdate(id, updateData, { new: true });
  },

  async delete(id: string): Promise<ITemplate | null> {
    return await Template.findByIdAndUpdate(id, { isActive: false }, { new: true });
  }
};
