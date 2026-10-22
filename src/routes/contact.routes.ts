import { Router, Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { contactController } from '../controllers/contact.controller';
import { submitContactSchema } from '../validators/contact.validator';
import { contactAttemptLimiter, contactRateLimiter } from '../middlewares/rateLimiter';

const router = Router();

const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  const parsed = schema.safeParse({ body: req.body });
  if (!parsed.success) {
    const issues = parsed.error.issues;
    // Only the field path and a human-readable message are exposed (not the validator's internals)
    const details = issues.map((i) => ({ path: i.path, message: i.message }));
    return res.status(400).json({ success: false, error: 'Validation Error', message: issues[0]?.message || 'Invalid input data', details });
  }
  req.body = { ...req.body, ...(parsed.data as any).body };
  next();
};

// POST /api/v1/public/contact — unauthenticated by design (visitors have no account)
router.post('/', contactAttemptLimiter, contactRateLimiter, validate(submitContactSchema), contactController.submit);

export default router;
