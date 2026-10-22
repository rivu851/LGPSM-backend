import jsQR from 'jsqr';
import sharp from 'sharp';

/** Decodes the QR code in a rendered card/poster the way a scanner would; null when nothing readable is found. */
export async function decodeQr(image: Buffer): Promise<string | null> {
  // scanners work on a normal-sized photo of the card, so decode a copy no larger than 1600 px
  const { data, info } = await sharp(image).flatten({ background: '#ffffff' }).resize({ width: 1600, withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: 'dontInvert' });
  return code ? code.data : null;
}
