import { templateRepository } from '../repositories/template.repository';
import { ITemplate } from '../models/Template';

export const templateService = {
  async createTemplate(data: Partial<ITemplate>): Promise<ITemplate> {
    return await templateRepository.create(data);
  },

  async getTemplates(categoryId?: string, includeDrafts = false): Promise<ITemplate[]> {
    return await templateRepository.findAll(categoryId, includeDrafts);
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
