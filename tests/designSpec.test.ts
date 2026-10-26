import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { CANVAS_PRESETS, CanvasPresetId, parseDesignSpec, safeParseDesignSpec, DesignSpec } from '../src/services/cardTemplates/designSpec';
import { renderDesignSpec } from '../src/services/cardTemplates/specRenderer';
import { buildSpecTexts } from '../src/services/cardTemplates/content';
import { convertStitchDesign } from '../src/services/stitch/stitch.converter';
import { SAMPLE_TEXTS } from '../src/services/stitch/sampleData';
import { decodeQr } from './helpers/qr';

jest.setTimeout(120000);

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const TOKEN_URL = `https://lgpsm-frontend.vercel.app/invitation/${'ab12'.repeat(16)}`;

async function convertedSpec(preset: CanvasPresetId = 'INVITATION_PORTRAIT'): Promise<DesignSpec> {
  const r = await convertStitchDesign({ html: fixture('stitch-gala.html').toString('utf8'), screenshot: fixture('stitch-gala.png'), kind: CANVAS_PRESETS[preset].kind, preset });
  if (!r.ready || !r.spec) throw new Error(`fixture did not convert: ${r.notes.join('; ')}`);
  return r.spec;
}
const qrPng = (url: string) => QRCode.toBuffer(url, { errorCorrectionLevel: 'H', margin: 4, width: 480 });

describe('design specification schema', () => {
  it('accepts what the converter produces for every canvas size', async () => {
    for (const preset of Object.keys(CANVAS_PRESETS) as CanvasPresetId[]) {
      const spec = await convertedSpec(preset);
      expect(parseDesignSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
      expect(spec.canvas.width).toBe(CANVAS_PRESETS[preset].width);
    }
  });

  it('rejects anything outside the closed format: unknown fields, URLs, markup, scripts, fonts it does not ship', async () => {
    const base = JSON.parse(JSON.stringify(await convertedSpec()));
    const bad = (mutate: (s: any) => void) => {
      const s = JSON.parse(JSON.stringify(base));
      mutate(s);
      return safeParseDesignSpec(s).ok;
    };
    expect(bad(() => undefined)).toBe(true);
    expect(bad((s) => (s.onload = 'alert(1)'))).toBe(false);
    expect(bad((s) => (s.elements[3].href = 'https://evil.example/x.png'))).toBe(false);
    expect(bad((s) => (s.background = 'url(https://evil.example/x.png)'))).toBe(false);
    expect(bad((s) => (s.background = 'red; } body { display:none'))).toBe(false);
    expect(bad((s) => s.elements.push({ type: 'html', markup: '<script>alert(1)</script>' }))).toBe(false);
    expect(bad((s) => s.elements.push({ type: 'image', slot: 'photo', x: 0, y: 0, w: 100, h: 100, src: 'https://169.254.169.254/' }))).toBe(false);
    const text = base.elements.findIndex((e: any) => e.type === 'text');
    expect(bad((s) => (s.elements[text].fontFamily = 'Comic Sans; src:url(x)'))).toBe(false);
    expect(bad((s) => (s.elements[text].color = 'javascript:alert(1)'))).toBe(false);
    expect(bad((s) => (s.elements[text].content = '<img src=x onerror=alert(1)>'))).toBe(false);
    // a "label" can only say one of the fixed phrases
    expect(bad((s) => s.elements.push({ ...s.elements[text], role: 'label', label: 'Dr. Eleanor Vance' }))).toBe(false);
  });

  it('enforces size, aspect, element count and QR rules', async () => {
    const base = JSON.parse(JSON.stringify(await convertedSpec()));
    const check = (mutate: (s: any) => void) => {
      const s = JSON.parse(JSON.stringify(base));
      mutate(s);
      return safeParseDesignSpec(s).ok;
    };
    expect(check((s) => (s.canvas.width = 100000))).toBe(false);
    expect(check((s) => ((s.canvas.width = 3000), (s.canvas.height = 700)))).toBe(false);
    expect(check((s) => (s.elements = Array.from({ length: 61 }, () => s.elements[0])))).toBe(false);
    expect(check((s) => (s.elements = s.elements.filter((e: any) => e.type !== 'qr')))).toBe(false); // an invitation needs its check-in QR
    expect(check((s) => (s.elements.find((e: any) => e.type === 'qr').purpose = 'REGISTRATION'))).toBe(false);
    expect(check((s) => (s.elements.find((e: any) => e.type === 'qr').x = 5000))).toBe(false);
    expect(check((s) => s.elements.push({ ...s.elements.find((e: any) => e.type === 'qr') }))).toBe(false); // only one QR
    expect(check((s) => (s.version = 2))).toBe(false);
  });
});

describe('design renderer', () => {
  it('draws real event values, not the sample text, and keeps the canvas size', async () => {
    const spec = await convertedSpec();
    const texts = buildSpecTexts({ title: 'Moloy & Dola Wedding Reception', startIso: '2026-11-07T18:00:00+05:30', endIso: '2026-11-07T22:00:00+05:30', venue: '24 Shanti Pally, Kolkata', organizerName: 'Roy Events', invitee: { name: 'Mr. Jagadish Harsh', companyName: 'Acme Ltd' } });
    expect(texts.dateTime).toContain('November');
    expect(texts.inviteeName).toBe('Mr. Jagadish Harsh');
    const out = await renderDesignSpec({ spec, texts, qr: await qrPng(TOKEN_URL) });
    expect([out.width, out.height]).toEqual([1080, 1920]);
    expect(out.warnings).toEqual([]);
    const sample = await renderDesignSpec({ spec, texts: SAMPLE_TEXTS.INVITATION, qr: await qrPng(TOKEN_URL) });
    expect(out.png.equals(sample.png)).toBe(false);
  });

  it("produces a QR code that a scanner reads back exactly (per-guest codes differ)", async () => {
    const spec = await convertedSpec();
    for (const url of [TOKEN_URL, `https://lgpsm-frontend.vercel.app/invitation/${'cd34'.repeat(16)}`]) {
      const out = await renderDesignSpec({ spec, texts: SAMPLE_TEXTS.INVITATION, qr: await qrPng(url) });
      expect(await decodeQr(out.png)).toBe(url);
    }
    const poster = await convertedSpec('POSTER_A4');
    const link = 'https://lgpsm-frontend.vercel.app/events/register?e=1';
    expect(await decodeQr((await renderDesignSpec({ spec: poster, texts: SAMPLE_TEXTS.POSTER, qr: await qrPng(link) })).png)).toBe(link);
  });

  it('keeps long and multi-script text inside its space and says when it had to shorten it', async () => {
    const spec = await convertedSpec();
    const long = 'The International Conference on Distributed Sustainable Energy Systems and Smart Grid Integration 2026 Edition';
    const out = await renderDesignSpec({ spec, texts: { ...SAMPLE_TEXTS.INVITATION, title: long, inviteeName: 'শ্রীমতী অনন্যা চট্টোপাধ্যায় এবং পরিবার', venue: 'A'.repeat(300) }, qr: await qrPng(TOKEN_URL) });
    expect(out.warnings.some((w) => /venue/.test(w))).toBe(true);
    expect((await sharp(out.png).metadata()).width).toBe(1080);
  });

  it('treats markup, control characters and SVG tricks in event text as plain text', async () => {
    const spec = await convertedSpec();
    const evil = '</text><script>alert(1)</script><image href="https://evil.example/x.png"/><text>&entity; \u0000\u0007';
    const out = await renderDesignSpec({ spec, texts: { ...SAMPLE_TEXTS.INVITATION, title: evil, venue: evil, inviteeName: evil }, qr: await qrPng(TOKEN_URL) });
    expect((await sharp(out.png).metadata()).format).toBe('png');
  });

  it('survives an unusable event image and a missing QR with warnings, not a crash', async () => {
    const spec = await convertedSpec();
    const out = await renderDesignSpec({ spec, texts: SAMPLE_TEXTS.INVITATION, logo: Buffer.from('not an image'), photo: Buffer.from('nope') });
    expect(out.warnings.join(' ')).toMatch(/QR/);
  });
});

describe('Stitch concept conversion', () => {
  const html = () => fixture('stitch-gala.html').toString('utf8');

  it('keeps the concept\'s style (palette, fonts, frame) but none of its sample content', async () => {
    const r = await convertStitchDesign({ html: html(), screenshot: fixture('stitch-gala.png'), kind: 'INVITATION', preset: 'INVITATION_PORTRAIT' });
    expect(r.ready).toBe(true);
    expect(r.fidelity).toBe('STYLE_ADAPTED');
    expect(r.style).toMatchObject({ headingFont: 'Playfair Display', bodyFont: 'Manrope' });
    expect(r.style!.accent.toLowerCase()).toBe('#d4af37'); // the concept's gold
    const json = JSON.stringify(r.spec);
    for (const leaked of ['Eleanor', 'Vance', 'Lumen', 'Grand Ballroom', 'Annual Gala', 'http', '<', 'script', 'tailwind', 'googleapis']) expect(json).not.toContain(leaked);
  });

  it('turns hostile HTML into plain data: nothing in it is executed, copied or fetched', async () => {
    const hostile = `<html><head><script>require('fs').writeFileSync('/tmp/pwned','x')</script>
      <script id="tailwind-config">tailwind.config={theme:{extend:{colors:{"background":"#0b0b0b","primary":"#c9a227","on-surface":"url(javascript:alert(1))"},fontFamily:{"headline":["Evil;src:url(//evil.example/f.woff)"]}}}}</script>
      <link href="https://evil.example/x.css" rel="stylesheet"><style>@import url(//evil.example/a.css); body{background:url(https://evil.example/t.gif)}</style></head>
      <body onload="fetch('//evil.example')"><img src="https://evil.example/pixel.png" onerror="alert(1)"><a href="javascript:alert(1)">x</a><iframe src="https://evil.example"></iframe></body></html>`;
    const r = await convertStitchDesign({ html: hostile, kind: 'INVITATION', preset: 'INVITATION_PORTRAIT' });
    expect(fs.existsSync('/tmp/pwned')).toBe(false);
    const json = JSON.stringify(r.spec || {});
    for (const bad of ['evil.example', 'javascript', 'alert', 'onerror', 'onload', 'iframe', 'script', 'url(']) expect(json).not.toContain(bad);
    if (r.ready) expect(safeParseDesignSpec(r.spec).ok).toBe(true);
  });

  it('converts a concept the provider sent as an SVG drawing, reading colours and fonts as text only', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
      <script>require('fs').writeFileSync('/tmp/pwned-svg','x')</script>
      <rect width="1080" height="1920" fill="#0b0c10"/><rect x="40" y="40" width="1000" height="1840" fill="none" stroke="#d4af37" stroke-width="4"/>
      <text x="540" y="400" font-family="'Playfair Display', serif" fill="#f5f5f5" onload="alert(1)">Sample Title</text>
      <text x="540" y="600" font-family="Manrope, sans-serif" fill="#d4af37">Sample label</text>
      <image href="https://evil.example/x.png" width="10" height="10"/></svg>`;
    const r = await convertStitchDesign({ html: svg, screenshot: fixture('stitch-gala.png'), kind: 'INVITATION', preset: 'INVITATION_PORTRAIT' });
    expect(fs.existsSync('/tmp/pwned-svg')).toBe(false);
    expect(r.ready).toBe(true);
    expect(r.style).toMatchObject({ headingFont: 'Playfair Display', bodyFont: 'Manrope' });
    expect(r.style!.accent.toLowerCase()).toBe('#d4af37');
    const json = JSON.stringify(r.spec);
    for (const leaked of ['Sample Title', 'evil.example', 'svg', 'alert', 'script', 'http']) expect(json).not.toContain(leaked);
  });

  it('says honestly when a concept cannot become a template', async () => {
    const empty = await convertStitchDesign({ html: '<html><body></body></html>', kind: 'INVITATION', preset: 'INVITATION_PORTRAIT' });
    expect(empty.ready).toBe(false);
    expect(empty.spec).toBeUndefined();
    expect(empty.fidelity).toBe('NONE');
    expect(empty.notes.length).toBeGreaterThan(0);
    const huge = await convertStitchDesign({ html: 'x'.repeat(2_000_000), kind: 'INVITATION', preset: 'INVITATION_PORTRAIT' });
    expect(huge.ready).toBe(false);
    const wrongSize = await convertStitchDesign({ html: html(), kind: 'POSTER', preset: 'INVITATION_PORTRAIT' });
    expect(wrongSize.ready).toBe(false);
  });

  it('adapts the layout to poster and landscape canvases with a registration QR', async () => {
    const spec = await convertedSpec('POSTER_LANDSCAPE');
    expect(spec.kind).toBe('POSTER');
    expect(spec.elements.find((e) => e.type === 'qr')).toMatchObject({ purpose: 'REGISTRATION' });
    expect(spec.elements.some((e) => e.type === 'text' && e.role === 'inviteeName')).toBe(false); // a poster has no personal guest line
  });
});
