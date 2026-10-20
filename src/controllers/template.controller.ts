import { Request, Response } from 'express';
import { templateService } from '../services/template.service';
import { installDefaultTemplates, planDefaultTemplates } from '../services/cardTemplates/defaultTemplates';
import { renderTemplatePreview } from '../services/cardTemplates/preview';

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
      const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const result = await templateService.getTemplates(categoryId, isAdmin, { page, limit });
      return res.status(200).json({
        success: true,
        data: result.templates,
        meta: { page: result.page, limit: result.limit, total: result.total, totalPages: result.totalPages },
      });
    } catch (error: any) {
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  // What installing the designers' default templates would create (nothing is changed)
  async previewDefaults(_req: Request, res: Response) {
    try {
      return res.status(200).json({ success: true, data: await planDefaultTemplates() });
    } catch (error: any) {
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  },

  // Creates the designers' default templates (and any category they need) that do not exist yet
  async installDefaults(req: Request, res: Response) {
    try {
      const result = await installDefaultTemplates((req as any).user.userId);
      return res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'The default templates could not be installed. Please try again.' });
    }
  },

  // The card this template produces for the event being entered (nothing is saved)
  async previewCard(req: Request, res: Response) {
    try {
      const png = await renderTemplatePreview((req.params.id as string | undefined) ?? null, req.body, (req as any).user?.role === 'ADMIN');
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      // the QR on a preview is a placeholder; check-in recognises and rejects it
      res.setHeader('X-Invitation-Qr', 'SAMPLE');
      return res.status(200).send(png);
    } catch (error: any) {
      if (error.message === 'TEMPLATE_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'The preview could not be created. Please try again.' });
    }
  },

  async getTemplateById(req: Request, res: Response) {
    try {
      const template = await templateService.getTemplateById(req.params.id as string);
      return res.status(200).json({ success: true, data: template });
    } catch (error: any) {
      if (error.message === 'TEMPLATE_NOT_FOUND') return res.status(404).json({ error: 'Not Found', message: 'Template not found' });
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
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
      console.error('Request failed:', error?.message);
      return res.status(500).json({ error: 'Internal Server Error', message: 'Something went wrong. Please try again.' });
    }
  }
};
