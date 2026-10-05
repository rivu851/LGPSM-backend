import { Request, Response } from 'express';
import { templateService } from '../services/template.service';

export const templateController = {
  async createTemplate(req: Request, res: Response) {
    try {
      const template = await templateService.createTemplate(req.body);
      return res.status(201).json({ success: true, data: template });
    } catch (error: any) {
      return res.status(400).json({ error: 'Bad Request', message: error.message });
    }
  },

  async getTemplates(req: Request, res: Response) {
    try {
      const categoryId = req.query.categoryId as string;
      const isAdmin = (req as any).user?.role === 'ADMIN';
      const templates = await templateService.getTemplates(categoryId, isAdmin);
      return res.status(200).json({ success: true, data: templates });
    } catch (error: any) {
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  },

  async getTemplateById(req: Request, res: Response) {
    try {
      const template = await templateService.getTemplateById(req.params.id as string);
      return res.status(200).json({ success: true, data: template });
    } catch (error: any) {
      if (error.message === 'TEMPLATE_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  },

  async updateTemplate(req: Request, res: Response) {
    try {
      const template = await templateService.updateTemplate(req.params.id as string, req.body);
      return res.status(200).json({ success: true, data: template });
    } catch (error: any) {
      if (error.message === 'TEMPLATE_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
      return res.status(400).json({ error: 'Bad Request', message: error.message });
    }
  },

  async deleteTemplate(req: Request, res: Response) {
    try {
      const template = await templateService.deleteTemplate(req.params.id as string);
      return res.status(200).json({ success: true, message: 'Template deactivated successfully', data: template });
    } catch (error: any) {
      if (error.message === 'TEMPLATE_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
      return res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
  }
};
