import { env } from '../config/env';

/**
 * This API's public address with no trailing slash, or null when it is not known. PUBLIC_API_URL when set; otherwise the address
 * Render gives every web service (RENDER_EXTERNAL_URL), so emails link their images even if the setting was forgotten there.
 */
export const publicApiUrl = (): string | null => {
  const v = (env.PUBLIC_API_URL || process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(v) ? v : null;
};
