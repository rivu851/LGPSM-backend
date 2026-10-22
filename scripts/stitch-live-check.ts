// Genuine end-to-end check of the Stitch integration: real provider call -> artifact download -> conversion -> render.
// Consumes provider quota. Run:  npx tsx scripts/stitch-live-check.ts [outDir]
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import { env } from '../src/config/env';
import { sdkStitchProvider, StitchProviderError } from '../src/services/stitch/stitch.provider';
import { convertStitchDesign } from '../src/services/stitch/stitch.converter';
import { buildStitchPrompt, deviceFor } from '../src/services/stitch/templateGeneration.service';
import { renderDesignSpec } from '../src/services/cardTemplates/specRenderer';
import { SAMPLE_TEXTS } from '../src/services/stitch/sampleData';

(async () => {
  if (!env.STITCH_API_KEY) return console.error('STITCH_API_KEY is not set');
  const out = process.argv[2];
  const preset = 'INVITATION_PORTRAIT' as const;
  const prompt = buildStitchPrompt({ kind: 'INVITATION', preset, prompt: 'Elegant black and gold invitation for a corporate awards gala', style: { mood: 'elegant' } });
  const started = Date.now();
  try {
    const art = await sdkStitchProvider.generate({ title: 'LGPSM live check', prompt, device: deviceFor(preset) });
    console.log(`generated in ${Math.round((Date.now() - started) / 1000)}s: html ${art.html.length} bytes, screenshot ${art.screenshot.length} bytes`);
    const result = await convertStitchDesign({ html: art.html, screenshot: art.screenshot, kind: 'INVITATION', preset });
    console.log('conversion:', JSON.stringify({ ready: result.ready, fidelity: result.fidelity, notes: result.notes, style: result.style }));
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'live-concept.png'), art.screenshot);
      fs.writeFileSync(path.join(out, 'live-concept.html'), art.html);
      if (result.spec) {
        const qr = await QRCode.toBuffer('https://example.org/sample', { errorCorrectionLevel: 'H', margin: 4, width: 480 });
        fs.writeFileSync(path.join(out, 'live-render.png'), (await renderDesignSpec({ spec: result.spec, texts: SAMPLE_TEXTS.INVITATION, qr, scale: 0.5, showPlaceholders: true })).png);
      }
      console.log('saved to', out);
    }
  } catch (e) {
    console.error('FAILED:', e instanceof StitchProviderError ? `${e.kind}: ${e.message}` : (e as Error).message);
    process.exitCode = 1;
  }
})();
