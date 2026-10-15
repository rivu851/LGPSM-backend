import { Template, ITemplate } from '../models/Template';

export const templateRepository = {
  async create(data: Partial<ITemplate>): Promise<ITemplate> {
    return await Template.create(data);
  },

  async findAll(
    categoryId?: string,
    includeDrafts = false,
    options: { skip?: number; limit?: number } = {}
  ): Promise<ITemplate[]> {
    const query: any = { isActive: true };
    // Templates created before the publish flag existed count as published
    if (!includeDrafts) query.isPublished = { $ne: false };
    if (categoryId) query.categoryId = categoryId;
    let cursor = Template.find(query).populate('categoryId').sort({ createdAt: -1, _id: -1 });
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    return await cursor;
  },

  async count(categoryId?: string, includeDrafts = false): Promise<number> {
    const query: any = { isActive: true };
    if (!includeDrafts) query.isPublished = { $ne: false };
    if (categoryId) query.categoryId = categoryId;
    return await Template.countDocuments(query);
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
