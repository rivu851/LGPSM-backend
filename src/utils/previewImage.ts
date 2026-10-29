import sharp from 'sharp';

export interface ShapedImage {
  body: Buffer;
  contentType: string;
}

/**
 * On-screen previews do not need the full-size PNG the card is drawn as (about 1.4 MB). A caller may ask for a smaller copy
 * with `?width=<80-1600>` and/or `?format=webp`; the same card as WebP at preview width is a small fraction of the size.
 * Anything else about the request is ignored and the PNG is returned untouched, so emailed cards and downloads never change.
 */
export async function shapePreview(png: Buffer, query: Record<string, unknown>): Promise<ShapedImage> {
  const widthRaw = Number(Array.isArray(query.width) ? query.width[0] : query.width);
  const width = Number.isFinite(widthRaw) ? Math.min(1600, Math.max(80, Math.round(widthRaw))) : null;
  const webp = (Array.isArray(query.format) ? query.format[0] : query.format) === 'webp';
  if (!width && !webp) return { body: png, contentType: 'image/png' };

  let image = sharp(png);
  if (width) image = image.resize({ width, withoutEnlargement: true });
  return webp
    ? { body: await image.webp({ quality: 82 }).toBuffer(), contentType: 'image/webp' }
    : { body: await image.png({ compressionLevel: 9 }).toBuffer(), contentType: 'image/png' };
}
