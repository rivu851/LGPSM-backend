/*
 * Renders every invitation-card template with the designers' sample text (and a sample QR) so a change to the
 * artwork, fonts or layout can be checked by eye.
 *
 *   npx tsx scripts/preview-cards.ts [output-folder]      (default: ./card-previews, git-ignored)
 */
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { renderTemplateCard, sampleTexts, TEMPLATE_DESIGNS } from '../src/services/cardTemplates/renderer';

(async () => {
  const out = path.resolve(process.argv[2] || 'card-previews');
  fs.mkdirSync(out, { recursive: true });
  const qr = await QRCode.toBuffer('https://example.test/sample-not-a-real-invitation', { errorCorrectionLevel: 'H', margin: 4, width: 400 });
  const tiles: Buffer[] = [];
  for (const design of TEMPLATE_DESIGNS) {
    const started = Date.now();
    const png = await renderTemplateCard({ design, texts: sampleTexts(design), qr, useSamplePhoto: true });
    fs.writeFileSync(path.join(out, `${design}.png`), png);
    tiles.push(await sharp(png).resize({ height: 800 }).toBuffer());
    console.log(`${design.padEnd(14)} ${(png.length / 1024).toFixed(0)} KB  ${Date.now() - started} ms`);
  }
  const widths = await Promise.all(tiles.map(async (t) => (await sharp(t).metadata()).width || 0));
  let x = 0;
  const composites = tiles.map((input, i) => {
    const c = { input, left: x, top: 0 };
    x += widths[i] + 10;
    return c;
  });
  await sharp({ create: { width: x, height: 800, channels: 3, background: '#888' } }).composite(composites).png().toFile(path.join(out, 'all-designs.png'));
  console.log('wrote', path.join(out, 'all-designs.png'));
})();
