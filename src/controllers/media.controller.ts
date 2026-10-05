import { Request, Response, NextFunction } from 'express';
import { mediaService } from '../services/media.service';
import { MediaPurpose } from '../models/Media';
import { Role } from '../models/User';

// Which roles may upload each kind of image
const UPLOAD_ROLES: Record<MediaPurpose, Role[]> = {
  [MediaPurpose.TEMPLATE]: [Role.ADMIN],
  [MediaPurpose.EVENT_LOGO]: [Role.ADMIN, Role.ORGANIZER],
  [MediaPurpose.ORGANIZATION_LOGO]: [Role.ADMIN, Role.ORGANIZER],
  [MediaPurpose.AVATAR]: [Role.ADMIN, Role.ORGANIZER, Role.SYSTEM_USER]
};

export const mediaController = {
  async presign(req: Request, res: Response, next: NextFunction) {
    try {
      const { fileName, fileType } = req.body;
      const result = await mediaService.generatePresignedUrl(fileName, fileType);

      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  },

  async upload(req: Request, res: Response, next: NextFunction) {
    try {
      const purpose = String(req.body?.purpose || '') as MediaPurpose;
      if (!Object.values(MediaPurpose).includes(purpose)) {
        return res.status(400).json({ success: false, message: 'A valid upload purpose is required' });
      }
      const actor = (req as any).user as { userId: string; role: Role };
      if (!UPLOAD_ROLES[purpose].includes(actor.role)) {
        return res.status(403).json({ success: false, message: 'You are not allowed to upload this kind of image' });
      }
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) {
        return res.status(400).json({ success: false, message: 'Attach an image file' });
      }
      const stored = await mediaService.storeImage(actor.userId, purpose, file.buffer, file.originalname);
      res.status(201).json({ success: true, data: stored });
    } catch (error) {
      next(error);
    }
  },

  // Public: stored images back event cards, templates and invitation pages viewed by guests
  async serve(req: Request, res: Response, next: NextFunction) {
    try {
      const media = await mediaService.getImage(String(req.params.id));
      if (!media) {
        return res.status(404).json({ success: false, message: 'Image not found' });
      }
      res.setHeader('Content-Type', media.contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).send(media.data);
    } catch (error) {
      next(error);
    }
  }
};
