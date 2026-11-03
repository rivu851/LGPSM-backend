// Query strings are attacker-controlled and Express hands over an array when a name is repeated (?a=1&a=2), so nothing reads
// req.query directly as a string. Page sizes are bounded here so one request cannot pull a whole collection.
export const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/** The value when it is a non-empty string; undefined for anything else. */
export const queryString = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** A valid ObjectId string, undefined when absent, and a 400 when present but malformed. */
export function queryObjectId(value: unknown, name: string): string | undefined {
  const text = queryString(value);
  if (text === undefined) return undefined;
  if (!OBJECT_ID_PATTERN.test(text)) throw { statusCode: 400, message: `Invalid ${name} format` };
  return text;
}

export function pageParams(query: { page?: unknown; limit?: unknown }, defaults: { limit: number; max: number }): { page: number; limit: number } {
  const page = Math.max(parseInt(String(query.page ?? ''), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(String(query.limit ?? ''), 10) || defaults.limit, 1), defaults.max);
  return { page, limit };
}
