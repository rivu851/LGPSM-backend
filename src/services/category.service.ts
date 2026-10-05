import { categoryRepository } from '../repositories/category.repository';
import { Category, ICategory } from '../models/Category';

const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const categoryService = {
  async createCategory(data: Partial<ICategory>): Promise<ICategory> {
    const name = String(data.name || '').trim();
    const existing = await Category.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') });
    if (existing) {
      throw { statusCode: 409, message: `A category named "${existing.name}" already exists` };
    }
    return await categoryRepository.create({ ...data, name });
  },

  // Appends one subcategory. Existing subcategories keep their ids, so templates and events that
  // reference them stay valid (rewriting the whole array would mint new ids).
  async addSubcategory(id: string, rawName: string): Promise<ICategory> {
    const name = rawName.trim();
    const category = await Category.findById(id);
    if (!category) throw new Error('CATEGORY_NOT_FOUND');
    if (category.subcategories.some((s) => s.name.trim().toLowerCase() === name.toLowerCase())) {
      throw { statusCode: 409, message: `"${name}" already exists in ${category.name}` };
    }
    category.subcategories.push({ name, isActive: true } as any);
    await category.save();
    return category;
  },

  async getCategories(activeOnly: boolean = true): Promise<ICategory[]> {
    return await categoryRepository.findAll(activeOnly);
  },

  async getCategoryById(id: string): Promise<ICategory> {
    const category = await categoryRepository.findById(id);
    if (!category) throw new Error('CATEGORY_NOT_FOUND');
    return category;
  },

  async updateCategory(id: string, updateData: Partial<ICategory>): Promise<ICategory> {
    const category = await categoryRepository.update(id, updateData);
    if (!category) throw new Error('CATEGORY_NOT_FOUND');
    return category;
  },

  async deleteCategory(id: string): Promise<ICategory> {
    const category = await categoryRepository.delete(id);
    if (!category) throw new Error('CATEGORY_NOT_FOUND');
    return category;
  }
};
