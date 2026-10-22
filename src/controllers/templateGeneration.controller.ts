import { Request, Response } from 'express';
import { CANVAS_PRESETS } from '../services/cardTemplates/designSpec';
import { SPEC_FONTS } from '../services/cardTemplates/designSpec';
import { GenerationError, templateGenerationService, serializeJob } from '../services/stitch/templateGeneration.service';
import { getStitchProvider } from '../services/stitch/stitch.provider';
import { env } from '../config/env';
import { MOODS } from '../validators/template.validator';
import { securityEvent } from '../utils/securityLog';

const actorOf = (req: Request) => ({ userId: (req as any).user.userId as string, role: (req as any).user.role as string });

function fail(req: Request, res: Response, error: unknown) {
  if (error instanceof GenerationError) {
    if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    if (error.code === 'JOB_NOT_FOUND' || error.code === 'VARIANT_NOT_FOUND') securityEvent('TEMPLATE_GENERATION_DENIED', req, { code: error.code });
    return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  }
  console.error('Request failed:', (error as any)?.message);
  return res.status(500).json({ success: false, code: 'INTERNAL', message: 'Something went wrong. Please try again.' });
}

export const templateGenerationController = {
  // What the apps need to build the form, so web and mobile never hard-code sizes or limits
  options(_req: Request, res: Response) {
    return res.status(200).json({
      success: true,
      data: {
        available: getStitchProvider().isConfigured(),
        presets: Object.entries(CANVAS_PRESETS).map(([id, p]) => ({ id, kind: p.kind, width: p.width, height: p.height, label: p.label })),
        moods: MOODS,
        limits: { promptMin: 10, promptMax: 800, changeMax: 500, maxVariants: 3, dailyQuota: env.STITCH_DAILY_QUOTA_PER_USER },
        fonts: SPEC_FONTS
      }
    });
  },

  async create(req: Request, res: Response) {
    try {
      const { job, deduplicated } = await templateGenerationService.createJob(actorOf(req), req.body);
      return res.status(deduplicated ? 200 : 202).json({ success: true, deduplicated, data: serializeJob(job) });
    } catch (error) {
      return fail(req, res, error);
    }
  },

  async list(req: Request, res: Response) {
    try {
      const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const result = await templateGenerationService.listJobs(actorOf(req), { page, limit });
      return res.status(200).json({ success: true, data: result.jobs.map(serializeJob), meta: { page: result.page, limit: result.limit, total: result.total } });
    } catch (error) {
      return fail(req, res, error);
    }
  },

  async get(req: Request, res: Response) {
    try {
      const job = await templateGenerationService.getJob(actorOf(req), req.params.id as string);
      return res.status(200).json({ success: true, data: serializeJob(job) });
    } catch (error) {
      return fail(req, res, error);
    }
  },

  async remove(req: Request, res: Response) {
    try {
      await templateGenerationService.deleteJob(actorOf(req), req.params.id as string);
      return res.status(200).json({ success: true, message: 'Generation deleted' });
    } catch (error) {
      return fail(req, res, error);
    }
  },

  async edit(req: Request, res: Response) {
    try {
      const { job, deduplicated } = await templateGenerationService.editVariant(actorOf(req), req.params.id as string, Number(req.params.index), req.body.prompt, req.body.idempotencyKey);
      return res.status(deduplicated ? 200 : 202).json({ success: true, deduplicated, data: serializeJob(job) });
    } catch (error) {
      return fail(req, res, error);
    }
  },

  async variations(req: Request, res: Response) {
    try {
      const { job, deduplicated } = await templateGenerationService.createVariations(actorOf(req), req.params.id as string, Number(req.params.index), req.body.prompt, req.body.variantCount || 2, req.body.idempotencyKey);
      return res.status(deduplicated ? 200 : 202).json({ success: true, deduplicated, data: serializeJob(job) });
    } catch (error) {
      return fail(req, res, error);
    }
  },

  async save(req: Request, res: Response) {
    try {
      const { template, alreadySaved } = await templateGenerationService.saveVariant(actorOf(req), req.params.id as string, Number(req.params.index), req.body);
      return res.status(alreadySaved ? 200 : 201).json({ success: true, alreadySaved, data: template });
    } catch (error) {
      return fail(req, res, error);
    }
  }
};
