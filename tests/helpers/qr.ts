import jsQR from 'jsqr';
import sharp from 'sharp';

/**
 * Decodes the QR code in a rendered card/poster the way a scanner would; null when nothing readable is found.
 * Phone cameras read light-on-dark codes too (the uploaded designs print the code straight on the picture), so the negative is tried as well.
 */
export async function decodeQr(image: Buffer): Promise<string | null> {
  // scanners work on a normal-sized photo of the card, so decode a copy no larger than 1600 px
  const base = sharp(image).flatten({ background: '#ffffff' }).resize({ width: 1600, withoutEnlargement: true });
  for (const negate of [false, true]) {
    const { data, info } = await (negate ? base.clone().negate({ alpha: false }) : base.clone()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const code = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: 'dontInvert' });
    if (code) return code.data;
  }
  return null;
}
