import { categoryRepository } from '../repositories/category.repository';
import mongoose from 'mongoose';
import { Category, ICategory } from '../models/Category';
import { Template } from '../models/Template';

const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const isMine = (ownerId: unknown, viewerId?: string) => !!ownerId && !!viewerId && String(ownerId) === String(viewerId);

/**
 * A category as one viewer sees it: the platform's own list plus their own custom ones. Other organizers' custom categories
 * and subcategories are not there at all, and `isCustom` marks the viewer's own so the screens can say so.
 */
export function viewFor(category: any, viewerId?: string) {
  const doc = typeof category.toObject === 'function' ? category.toObject() : category;
  return {
    ...doc,
    isCustom: !!doc.ownerId,
    subcategories: (doc.subcategories || [])
      .filter((s: any) => !s.ownerId || isMine(s.ownerId, viewerId))
      .map((s: any) => ({ ...s, isCustom: !!s.ownerId }))
  };
}

/** May this person use (pick, attach to an event or template) the category and subcategory? Someone else's custom ones are treated as missing. */
export async function canUseCategory(categoryId: string, subcategoryId: string | undefined, viewerId?: string): Promise<boolean> {
  const category: any = await Category.findById(categoryId);
  if (!category) return false;
  if (category.ownerId && !isMine(category.ownerId, viewerId)) return false;
  // a custom category its owner deleted stays on the events that already had it, but cannot be chosen again
  if (category.ownerId && category.isActive === false) return false;
  if (subcategoryId) {
    const sub = (category.subcategories || []).find((x: any) => String(x._id) === String(subcategoryId));
    if (sub?.ownerId && !isMine(sub.ownerId, viewerId)) return false;
    if (sub?.ownerId && sub.isActive === false) return false;
  }
  return true;
}

export const categoryService = {
  /** An organizer's own category: only they see it. The name may not repeat anything they can already pick. */
  async createCustomCategory(ownerId: string, rawName: string): Promise<any> {
    const name = rawName.trim();
    const pickable = await Category.find({ isActive: { $ne: false }, $or: [{ ownerId: null }, { ownerId }] }).select('name').lean();
    const clash = pickable.find((c: any) => same(c.name, name));
    if (clash) throw { statusCode: 409, message: `"${clash.name}" is already in your list. Pick it from the dropdown.` };
    // A name they deleted earlier comes back as the same category, so events that kept it stay linked to it
    const retired = (await Category.find({ ownerId, isActive: false })).find((c) => same(c.name, name));
    if (retired) {
      retired.name = name;
      retired.isActive = true;
      await retired.save();
      return viewFor(retired, ownerId);
    }
    try {
      return viewFor(await Category.create({ name, ownerId, isActive: true }), ownerId);
    } catch (e: any) {
      // another organizer holds the same custom name and the database still has the old global unique index (see the migration script)
      if (e?.code === 11000) throw { statusCode: 409, message: 'That name is not available. Please use a different one.' };
      throw e;
    }
  },

  /** An organizer's own subcategory, under the platform's category or one of their own. Nobody else sees it. */
  async addCustomSubcategory(ownerId: string, categoryId: string, rawName: string): Promise<any> {
    const name = rawName.trim();
    const category = await Category.findById(categoryId);
    if (!category || !category.isActive || (category.ownerId && !isMine(category.ownerId, ownerId))) throw new Error('CATEGORY_NOT_FOUND');
    const mineOrPlatform = category.subcategories.filter((s: any) => (!s.ownerId || isMine(s.ownerId, ownerId)) && same(s.name, name));
    const clash = mineOrPlatform.find((s: any) => s.isActive !== false);
    if (clash) throw { statusCode: 409, message: `"${clash.name}" is already in ${category.name}. Pick it from the dropdown.` };
    // A name they deleted earlier comes back as the same subcategory, so events that kept it stay linked to it
    const retired: any = mineOrPlatform.find((s: any) => s.ownerId);
    if (retired) {
      retired.name = name;
      retired.isActive = true;
    } else {
      category.subcategories.push({ name, isActive: true, ownerId } as any);
    }
    await category.save();
    return viewFor(category, ownerId);
  },

  /**
   * An organizer removing their own custom category. It stops being offered, while events that already use it keep it (their cards
   * and reports still show its name). Their templates filed under it become general templates, because choosing one must not fill a
   * category that is no longer available into a new event.
   */
  async deleteCustomCategory(ownerId: string, categoryId: string): Promise<any> {
    if (!mongoose.Types.ObjectId.isValid(categoryId)) throw new Error('CATEGORY_NOT_FOUND');
    const category = await Category.findOne({ _id: categoryId, ownerId, isActive: { $ne: false } });
    if (!category) throw new Error('CATEGORY_NOT_FOUND');
    category.isActive = false;
    await category.save();
    await Template.updateMany({ ownerId, categoryId: category._id }, { $unset: { categoryId: 1, subcategoryId: 1 } });
    return viewFor(category, ownerId);
  },

  /** The same for one of their own subcategories, under the platform's category or their own. The platform's subcategories are not theirs to remove. */
  async deleteCustomSubcategory(ownerId: string, categoryId: string, subcategoryId: string): Promise<any> {
    if (!mongoose.Types.ObjectId.isValid(categoryId) || !mongoose.Types.ObjectId.isValid(subcategoryId)) throw new Error('CATEGORY_NOT_FOUND');
    const category = await Category.findById(categoryId);
    const sub: any = category?.subcategories.find((s: any) => String(s._id) === subcategoryId);
    if (!category || !sub || !isMine(sub.ownerId, ownerId) || sub.isActive === false) throw new Error('CATEGORY_NOT_FOUND');
    sub.isActive = false;
    await category.save();
    await Template.updateMany({ ownerId, subcategoryId: sub._id }, { $unset: { subcategoryId: 1 } });
    return viewFor(category, ownerId);
  },

  async createCategory(data: Partial<ICategory>): Promise<ICategory> {
    const name = String(data.name || '').trim();
    // Organizers' custom categories are private and do not reserve a name on the platform's list
    const existing = await Category.findOne({ name: new RegExp(`^${escapeRegex(name)}$`, 'i'), ownerId: null });
    if (existing) {
      throw { statusCode: 409, message: `A category named "${existing.name}" already exists` };
    }
    try {
      return await categoryRepository.create({ ...data, name });
    } catch (e: any) {
      // only reachable until scripts/migrate-category-uniqueness.js has replaced the old index
      if (e?.code === 11000) throw { statusCode: 409, message: 'That name is not available. Please use a different one.' };
      throw e;
    }
  },

  // Appends one subcategory. Existing subcategories keep their ids, so templates and events that
  // reference them stay valid (rewriting the whole array would mint new ids).
  async addSubcategory(id: string, rawName: string): Promise<ICategory> {
    const name = rawName.trim();
    const category = await Category.findById(id);
    if (!category) throw new Error('CATEGORY_NOT_FOUND');
    if (category.subcategories.some((s) => !s.ownerId && same(s.name, name))) {
      throw { statusCode: 409, message: `"${name}" already exists in ${category.name}` };
    }
    category.subcategories.push({ name, isActive: true } as any);
    await category.save();
    return category;
  },

  async getCategories(activeOnly: boolean = true, viewerId?: string): Promise<any[]> {
    const all = await categoryRepository.findAll(activeOnly);
    return all.filter((c: any) => !c.ownerId || isMine(c.ownerId, viewerId)).map((c) => viewFor(c, viewerId));
  },

  async getCategoryById(id: string, viewerId?: string): Promise<any> {
    const category: any = await categoryRepository.findById(id);
    if (!category || (category.ownerId && !isMine(category.ownerId, viewerId))) throw new Error('CATEGORY_NOT_FOUND');
    return viewFor(category, viewerId);
  },

  async updateCategory(id: string, updateData: Partial<ICategory>): Promise<ICategory> {
    // Organizers' custom subcategories are not shown to the administrator, so their save does not send them: keep them
    if (Array.isArray(updateData.subcategories)) {
      const current = await Category.findById(id).select('subcategories').lean<any>();
      const custom = (current?.subcategories || []).filter((s: any) => s.ownerId);
      if (custom.length) updateData = { ...updateData, subcategories: [...updateData.subcategories, ...custom] };
    }
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
