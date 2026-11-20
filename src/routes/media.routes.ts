import { Router, Request, Response, NextFunction } from 'express';
import { mediaController } from '../controllers/media.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { presignMediaSchema } from '../validators/media.validator';
import { ZodSchema } from 'zod';
import { mediaUploadLimiter } from '../middlewares/rateLimiter';
import { uploadImage } from '../middlewares/imageUpload';

const router = Router();

const validate = (schema: ZodSchema) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed: any = schema.parse({ body: req.body });
    req.body = { ...req.body, ...parsed.body };
    next();
  } catch (err: any) {
    res.status(400).json({ success: false, error: 'Validation Error', message: err.issues?.[0]?.message || 'Invalid input data', details: err.issues ?? err.errors });
  }
};

// S3 presigned upload (used when object storage is configured)
router.post('/presign', authenticate, authorizeRoles(Role.ORGANIZER), validate(presignMediaSchema), mediaController.presign);

// Direct upload stored by the API; the purpose decides which roles may upload
router.post('/upload', authenticate, mediaUploadLimiter, uploadImage, mediaController.upload);

router.get('/:id', mediaController.serve);

export default router;
