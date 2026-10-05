import { Template, ITemplate } from '../models/Template';

export const templateRepository = {
  async create(data: Partial<ITemplate>): Promise<ITemplate> {
    return await Template.create(data);
  },

  async findAll(categoryId?: string, includeDrafts = false): Promise<ITemplate[]> {
    const query: any = { isActive: true };
    // Templates created before the publish flag existed count as published
    if (!includeDrafts) query.isPublished = { $ne: false };
    if (categoryId) query.categoryId = categoryId;
    return await Template.find(query).populate('categoryId').sort({ createdAt: -1 });
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
