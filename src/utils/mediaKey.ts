// Stored image references are either external URLs / site paths, or `media:<objectId>` for images
// uploaded through POST /api/v1/media/upload.
const MEDIA_KEY = /^media:([0-9a-fA-F]{24})$/;

export function mediaIdFromKey(key: string | null | undefined): string | null {
  const match = key ? MEDIA_KEY.exec(key) : null;
  return match ? match[1] : null;
}

export function isAcceptedImageKey(key: string): boolean {
  return MEDIA_KEY.test(key) || /^https:\/\//.test(key) || /^\/[A-Za-z0-9/_.-]+$/.test(key);
}
