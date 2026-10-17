import { mediaService } from '../services/media.service';
import { mediaIdFromKey } from './mediaKey';

// Resolves a stored image reference (see mediaKey.ts: `media:<id>` from an upload, an external
// https URL, or a site-relative path) into an embeddable `data:` URI. Used to put an organizer's
// own uploaded photo into a server-rendered invitation card, instead of leaving it text-only.
// Returns '' (never throws) when the key is missing or the image can't be resolved, so a card
// render never fails just because a photo couldn't be loaded.
export async function resolveImageKeyBase64(key: string | null | undefined): Promise<string> {
  if (!key) return '';

  const mediaId = mediaIdFromKey(key);
  if (mediaId) {
    try {
      const media = await mediaService.getImage(mediaId);
      if (!media || !media.data) return '';
      return `data:${media.contentType};base64,${media.data.toString('base64')}`;
    } catch (err) {
      console.warn(`Could not resolve media image ${mediaId}:`, err);
      return '';
    }
  }

  if (/^https:\/\//.test(key)) {
    try {
      const res = await fetch(key);
      if (!res.ok) return '';
      const contentType = res.headers.get('content-type') || 'image/jpeg';
      const buffer = Buffer.from(await res.arrayBuffer());
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    } catch (err) {
      console.warn(`Could not fetch external image ${key}:`, err);
      return '';
    }
  }

  // Bare site-relative paths (e.g. static branding assets) aren't resolvable from the backend
  // without a configured public base URL; skip rather than guess.
  return '';
}
