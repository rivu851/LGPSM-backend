import { templateRepository } from '../repositories/template.repository';
import { ITemplate } from '../models/Template';

export const templateService = {
  async createTemplate(data: Partial<ITemplate>): Promise<ITemplate> {
    return await templateRepository.create(data);
  },

  async getTemplates(
    categoryId?: string,
    includeDrafts = false,
    options: { page?: number; limit?: number } = {}
  ) {
    const page = Math.max(options.page || 1, 1);
    const limit = Math.min(Math.max(options.limit || 25, 1), 100);
    const skip = (page - 1) * limit;

    const [templates, total] = await Promise.all([
      templateRepository.findAll(categoryId, includeDrafts, { skip, limit }),
      templateRepository.count(categoryId, includeDrafts),
    ]);

    return { templates, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
  },

  async getTemplateById(id: string): Promise<ITemplate> {
    const template = await templateRepository.findById(id);
    if (!template) throw new Error('TEMPLATE_NOT_FOUND');
    return template;
  },

  async updateTemplate(id: string, updateData: Partial<ITemplate>): Promise<ITemplate> {
    const template = await templateRepository.update(id, updateData);
    if (!template) throw new Error('TEMPLATE_NOT_FOUND');
    return template;
  },

  async deleteTemplate(id: string): Promise<ITemplate> {
    const template = await templateRepository.delete(id);
    if (!template) throw new Error('TEMPLATE_NOT_FOUND');
    return template;
  }
};
