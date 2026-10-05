import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { mediaController } from '../controllers/media.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';
import { presignMediaSchema } from '../validators/media.validator';
import { MAX_UPLOAD_BYTES } from '../services/media.service';
import { ZodSchema } from 'zod';

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

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    // The real content check happens when the image is decoded; this rejects obvious non-images early
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG or WEBP images are supported'));
  }
});

// S3 presigned upload (used when object storage is configured)
router.post('/presign', authenticate, authorizeRoles(Role.ORGANIZER), validate(presignMediaSchema), mediaController.presign);

// Direct upload stored by the API; the purpose decides which roles may upload
router.post('/upload', authenticate, (req, res, next) => {
  imageUpload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'Image must be 5 MB or smaller' });
    }
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
}, mediaController.upload);

router.get('/:id', mediaController.serve);

export default router;
