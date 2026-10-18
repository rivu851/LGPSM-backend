import { mediaService } from '../services/media.service';
import { mediaIdFromKey } from './mediaKey';
import { fetchPublicImage } from './safeFetch';
import { securityEvent } from './securityLog';

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
      const { contentType, buffer } = await fetchPublicImage(key);
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    } catch (err) {
      // Not logging the URL: it is user-supplied and may carry tokens
      if (err instanceof Error && /not allowed/i.test(err.message)) securityEvent('SSRF_BLOCKED');
      console.warn('Could not fetch external image:', err instanceof Error ? err.message : 'unknown error');
      return '';
    }
  }

  // Bare site-relative paths (e.g. static branding assets) aren't resolvable from the backend
  // without a configured public base URL; skip rather than guess.
  return '';
}
