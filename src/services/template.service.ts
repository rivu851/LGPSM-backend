import mongoose from 'mongoose';
import { templateRepository, TemplateViewer } from '../repositories/template.repository';
import { ITemplate, Template } from '../models/Template';

/** Can this viewer see/use this template? Mirrors the list rules in template.repository.ts. */
export function templateVisibleTo(template: Pick<ITemplate, 'ownerId' | 'isPublished' | 'isSystemTemplate' | 'isActive'>, viewer: TemplateViewer): boolean {
  if (template.isActive === false && !viewer.isAdmin) return false;
  if (viewer.isAdmin) return true;
  if (template.ownerId) return String(template.ownerId) === viewer.userId || (template.isSystemTemplate && template.isPublished === true);
  return template.isPublished !== false;
}

export const templateService = {
  async createTemplate(data: Partial<ITemplate>): Promise<ITemplate> {
    return await templateRepository.create(data);
  },

  async getTemplates(
    categoryId: string | undefined,
    viewer: TemplateViewer,
    options: { page?: number; limit?: number; mineOnly?: boolean; kind?: 'INVITATION' | 'POSTER' } = {}
  ) {
    const page = Math.max(options.page || 1, 1);
    const limit = Math.min(Math.max(options.limit || 25, 1), 100);
    const skip = (page - 1) * limit;
    const listOptions = { skip, limit, mineOnly: options.mineOnly, kind: options.kind };

    const [templates, total] = await Promise.all([
      templateRepository.findAll(categoryId, viewer, listOptions),
      templateRepository.count(categoryId, viewer, listOptions),
    ]);

    return { templates, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  },

  /** A template the viewer may see; anything else is reported as missing so another tenant's ids reveal nothing. */
  async getTemplateById(id: string, viewer?: TemplateViewer): Promise<ITemplate> {
    const template = await templateRepository.findById(id);
    if (!template || (viewer && !templateVisibleTo(template, viewer))) throw new Error('TEMPLATE_NOT_FOUND');
    return template;
  },

  async updateTemplate(id: string, updateData: Partial<ITemplate>): Promise<ITemplate> {
    const template = await templateRepository.update(id, updateData);
    if (!template) throw new Error('TEMPLATE_NOT_FOUND');
    return template;
  },

  /** An organizer changing their own AI template: only fields they may edit, only on a template they own. */
  async updateOwnTemplate(id: string, userId: string, updateData: Partial<ITemplate>): Promise<ITemplate> {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new Error('TEMPLATE_NOT_FOUND');
    const template = await Template.findOneAndUpdate({ _id: id, ownerId: userId, isActive: { $ne: false } }, updateData, { new: true });
    if (!template) throw new Error('TEMPLATE_NOT_FOUND');
    return template;
  },

  async deleteTemplate(id: string): Promise<ITemplate> {
    const template = await templateRepository.delete(id);
    if (!template) throw new Error('TEMPLATE_NOT_FOUND');
    return template;
  },

  async deleteOwnTemplate(id: string, userId: string): Promise<ITemplate> {
    if (!mongoose.Types.ObjectId.isValid(id)) throw new Error('TEMPLATE_NOT_FOUND');
    const template = await Template.findOneAndUpdate({ _id: id, ownerId: userId, isActive: { $ne: false } }, { isActive: false }, { new: true });
    if (!template) throw new Error('TEMPLATE_NOT_FOUND');
    return template;
  },

  /** May an event owned by `organizerId` use this template? Legacy/system templates always; an owned template only by its owner. */
  async isUsableByOrganizer(templateId: string, organizerId: string): Promise<boolean> {
    if (!mongoose.Types.ObjectId.isValid(templateId)) return false;
    const template = await Template.findById(templateId).select('ownerId isSystemTemplate isPublished isActive').lean();
    if (!template) return false;
    if (!template.ownerId) return true;
    if (template.isActive === false) return false;
    return String(template.ownerId) === String(organizerId) || (template.isSystemTemplate === true && template.isPublished === true);
  }
};
