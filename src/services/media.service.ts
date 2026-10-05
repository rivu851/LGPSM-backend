import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import sharp from 'sharp';
import s3Client from '../config/s3.config';
import { env } from '../config/env';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Media, MediaPurpose } from '../models/Media';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// Longest edge kept per purpose; larger images are downscaled before storing
const MAX_EDGE: Record<MediaPurpose, number> = {
  [MediaPurpose.TEMPLATE]: 1600,
  [MediaPurpose.EVENT_LOGO]: 800,
  [MediaPurpose.ORGANIZATION_LOGO]: 800,
  [MediaPurpose.AVATAR]: 512
};

export class MediaService {
  async generatePresignedUrl(fileName: string, fileType: string): Promise<{ uploadUrl: string; fileKey: string }> {
    const bucket = env.AWS_S3_BUCKET;
    if (!bucket) {
      throw new Error('S3_NOT_CONFIGURED');
    }

    // Generate unique key
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const extension = fileType === 'image/jpeg' ? 'jpg' : 'png';
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');

    const fileKey = `events/${uniqueId}/${sanitizedFileName}`;

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: fileKey,
      ContentType: fileType,
    });

    // 15 minutes expiration
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

    return { uploadUrl, fileKey };
  }

  // Decodes the upload (rejecting anything that is not a real image), strips metadata, bounds the size
  // and stores a normalized copy. The original bytes are never served back.
  async storeImage(ownerId: string, purpose: MediaPurpose, buffer: Buffer, originalName?: string) {
    const image = sharp(buffer, { failOn: 'error', limitInputPixels: 40_000_000 });
    let meta: Awaited<ReturnType<typeof image.metadata>>;
    try {
      meta = await image.metadata();
    } catch {
      throw { statusCode: 400, message: 'The file is not a valid image' };
    }
    if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) {
      throw { statusCode: 400, message: 'Only JPG, PNG or WEBP images are supported' };
    }

    // PNG only when transparency matters; opaque images are far smaller as JPEG
    const keepAlpha = !!meta.hasAlpha;
    const pipeline = image.rotate().resize({ width: MAX_EDGE[purpose], height: MAX_EDGE[purpose], fit: 'inside', withoutEnlargement: true });
    const { data, info } = keepAlpha
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer({ resolveWithObject: true });

    const media = await Media.create({
      ownerId: new mongoose.Types.ObjectId(ownerId),
      purpose,
      contentType: keepAlpha ? 'image/png' : 'image/jpeg',
      size: info.size,
      width: info.width,
      height: info.height,
      originalName: originalName?.slice(0, 200),
      data
    });

    return { key: `media:${media._id}`, contentType: media.contentType, width: info.width, height: info.height, size: info.size };
  }

  async getImage(id: string) {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    return Media.findById(id).select('+data contentType updatedAt');
  }
}

export const mediaService = new MediaService();
