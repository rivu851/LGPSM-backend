import { env } from '../config/env';

/** This API's public address with no trailing slash, or null when PUBLIC_API_URL is not set (or is not an http(s) address). */
export const publicApiUrl = (): string | null => {
  const v = (env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(v) ? v : null;
};
