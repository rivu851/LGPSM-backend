import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { MAX_UPLOAD_BYTES } from '../services/media.service';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG or WEBP images are supported'));
  }
}).single('file');

export function uploadImage(req: Request, res: Response, next: NextFunction) {
  upload(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'Image must be 5 MB or smaller' });
    }
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
}
