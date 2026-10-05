import { Request, Response } from 'express';
import { categoryService } from '../services/category.service';

export const categoryController = {
  async createCategory(req: Request, res: Response) {
    try {
      const category = await categoryService.createCategory(req.body);
      return res.status(201).json({ success: true, data: category });
    } catch (error: any) {
      if (error?.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
      return res.status(400).json({ success: false, error: 'Bad Request', message: error.message });
    }
  },

  async addSubcategory(req: Request, res: Response) {
    try {
      const category = await categoryService.addSubcategory(req.params.id as string, req.body.name);
      return res.status(201).json({ success: true, data: category });
    } catch (error: any) {
      if (error?.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
      if (error.message === 'CATEGORY_NOT_FOUND') return res.status(404).json({ success: false, message: 'Category not found' });
      return res.status(400).json({ success: false, message: error.message });
    }
  },

  async getCategories(req: Request, res: Response) {
    try {
      const activeOnly = req.query.activeOnly !== 'false';
      const categories = await categoryService.getCategories(activeOnly);
      return res.status(200).json({ success: true, data: categories });
    } catch (error: any) {
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  },

  async getCategoryById(req: Request, res: Response) {
    try {
      const category = await categoryService.getCategoryById(req.params.id as string);
      return res.status(200).json({ success: true, data: category });
    } catch (error: any) {
      if (error.message === 'CATEGORY_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Category not found' });
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  },

  async updateCategory(req: Request, res: Response) {
    try {
      const category = await categoryService.updateCategory(req.params.id as string, req.body);
      return res.status(200).json({ success: true, data: category });
    } catch (error: any) {
      if (error.message === 'CATEGORY_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Category not found' });
      return res.status(400).json({ error: 'Bad Request', message: error.message });
    }
  },

  async deleteCategory(req: Request, res: Response) {
    try {
      const category = await categoryService.deleteCategory(req.params.id as string);
      return res.status(200).json({ success: true, message: 'Category deactivated successfully', data: category });
    } catch (error: any) {
      if (error.message === 'CATEGORY_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Category not found' });
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  }
};
