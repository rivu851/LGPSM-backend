import { readFile } from 'fs/promises';
import sharp from 'sharp';
import { assetPath } from '../../utils/assetPath';
import type { EmailAttachment } from '../../utils/email.provider';

/**
 * The small images the invitation email uses besides the card: Material-style icons for the details rows and the LGPSM logo
 * (shown at the top until the organizer uploads their own). Gmail strips inline SVG, so each icon is drawn once to a PNG
 * (3x for sharp phone screens) and attached inline by cid. The email HTML refers to them by the ids below, and
 * `inlineImagesFor(html)` attaches exactly the ones a given email uses, so no unused image shows up as a loose attachment.
 */
export const PLATFORM_LOGO_CID = 'lgpsm-logo';
export const iconCid = (key: EmailIconKey) => `lgpsm-icon-${key}`;

const GREY = '#444746';
const BLUE = '#0B57D0';
// Material Icons paths (24 x 24)
const ICONS = {
  info: { color: BLUE, d: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z' },
  event: { color: GREY, d: 'M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z' },
  place: { color: GREY, d: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z' },
  person: { color: GREY, d: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM7.07 18.28c.43-.9 3.05-1.78 4.93-1.78s4.51.88 4.93 1.78C15.57 19.36 13.86 20 12 20s-3.57-.64-4.93-1.72zm11.29-1.45c-1.43-1.74-4.9-2.33-6.36-2.33s-4.93.59-6.36 2.33C4.62 15.49 4 13.82 4 12c0-4.41 3.59-8 8-8s8 3.59 8 8c0 1.82-.62 3.49-1.64 4.83zM12 6c-1.94 0-3.5 1.56-3.5 3.5S10.06 13 12 13s3.5-1.56 3.5-3.5S13.94 6 12 6zm0 5c-.83 0-1.5-.67-1.5-1.5S11.17 8 12 8s1.5.67 1.5 1.5S12.83 11 12 11z' },
  call: { color: GREY, d: 'M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z' },
  restaurant: { color: GREY, d: 'M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z' },
  qr: { color: BLUE, d: 'M3 11h8V3H3v8zm2-6h4v4H5V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zM13 3v8h8V3h-8zm6 6h-4V5h4v4zM19 19h2v2h-2zM13 13h2v2h-2zM15 15h2v2h-2zM13 17h2v2h-2zM15 19h2v2h-2zM17 17h2v2h-2zM17 13h2v2h-2zM19 15h2v2h-2z' },
  shield: { color: BLUE, d: 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z' },
} as const;
export type EmailIconKey = keyof typeof ICONS;

let cache: Promise<Map<string, EmailAttachment>> | null = null;
function images(): Promise<Map<string, EmailAttachment>> {
  cache ??= (async () => {
    const map = new Map<string, EmailAttachment>();
    for (const [key, { color, d }] of Object.entries(ICONS)) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 24 24"><path fill="${color}" d="${d}"/></svg>`;
      const content = await sharp(Buffer.from(svg)).png().toBuffer();
      map.set(iconCid(key as EmailIconKey), { filename: `${key}.png`, content, cid: iconCid(key as EmailIconKey), contentType: 'image/png' });
    }
    const logo = await readFile(assetPath('branding', 'lgpsm-logo.png')).catch(() => null);
    if (logo) map.set(PLATFORM_LOGO_CID, { filename: 'lgpsm-logo.png', content: logo, cid: PLATFORM_LOGO_CID, contentType: 'image/png' });
    return map;
  })().catch((err) => { cache = null; throw err; });
  return cache;
}

/** The icon and logo attachments this email's HTML refers to (an image that cannot be prepared is left out; the text still reads) */
export async function inlineImagesFor(html: string): Promise<EmailAttachment[]> {
  const all = await images().catch(() => new Map<string, EmailAttachment>());
  const used = new Set([...html.matchAll(/src="cid:([^"]+)"/g)].map((m) => m[1]));
  return [...all.values()].filter((a) => used.has(a.cid!));
}
