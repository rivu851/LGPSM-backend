import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { Media } from '../models/Media';

// Where an uploaded image's bytes are kept.
//  - MEDIA_DIR set:    as a file in that folder (the database keeps only a small record). Point it OUTSIDE the folder the app is deployed
//                      into, or a redeploy can remove the files.
//  - MEDIA_DIR not set: inside the database (the record carries the bytes), as before.
// Images saved either way are always readable, so the setting can be changed at any time without losing anything.

export const mediaDir = (): string | null => {
  const dir = (process.env.MEDIA_DIR || '').trim();
  return dir ? path.resolve(dir) : null;
};

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const extensionFor = (contentType: string) => EXT[contentType] || 'bin';

// only plain file names made by this module are ever opened (no folders, no "..")
const safeName = (name: string) => (/^[0-9a-f]{24}\.(jpg|png|webp|bin)$/.test(name) ? name : null);

async function setPermissions(target: string, mode: number, label: string): Promise<void> {
  try {
    await fs.promises.chmod(target, mode);
  } catch (error) {
    console.error(`[media-storage] Could not set ${label} permissions to ${mode.toString(8)} for ${target}:`, error instanceof Error ? error.message : error);
    throw error;
  }
}

export async function setPublicImagePermissions(filePath: string): Promise<void> {
  await setPermissions(filePath, 0o644, 'public image');
}

export async function writeMediaFile(id: string, contentType: string, data: Buffer): Promise<string> {
  const dir = mediaDir();
  if (!dir) throw new Error('MEDIA_DIR_NOT_SET');
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 });
  await setPermissions(dir, 0o755, 'public image directory');
  const name = `${id}.${extensionFor(contentType)}`;
  const target = path.join(dir, name);
  const temp = `${target}.${process.pid}.tmp`;
  // written beside the final name and renamed, so a half-written file is never served
  await fs.promises.writeFile(temp, data, { mode: 0o644 });
  await fs.promises.rename(temp, target);
  try {
    await setPublicImagePermissions(target);
  } catch (error) {
    try {
      await fs.promises.unlink(target);
    } catch (cleanupError) {
      console.error('[media-storage] Could not remove image after its permissions failed:', target, cleanupError instanceof Error ? cleanupError.message : cleanupError);
    }
    throw error;
  }
  return name;
}

export async function readMediaFile(fileName: string): Promise<Buffer | null> {
  const dir = mediaDir();
  const name = safeName(fileName);
  if (!dir || !name) return null;
  try { return await fs.promises.readFile(path.join(dir, name)); } catch { return null; }
}

/** The address the file is served from when MEDIA_PUBLIC_URL is set and the file is really there; otherwise null (the API serves the bytes). */
export async function publicUrlFor(fileName?: string | null): Promise<string | null> {
  const base = (process.env.MEDIA_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const dir = mediaDir();
  const name = fileName ? safeName(fileName) : null;
  if (!base || !/^https:\/\//i.test(base) || !dir || !name) return null;
  const filePath = path.join(dir, name);
  try {
    await setPublicImagePermissions(filePath);
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch { return null; }
  return `${base}/${name}`;
}

export async function removeMediaFile(fileName?: string | null): Promise<void> {
  const dir = mediaDir();
  const name = fileName ? safeName(fileName) : null;
  if (!dir || !name) return;
  try { await fs.promises.unlink(path.join(dir, name)); } catch { /* already gone */ }
}

/** Deletes image records and, for the ones kept as files, the files. Same filter as Media.deleteMany. */
export async function deleteMedia(filter: Record<string, unknown>): Promise<number> {
  const rows = await Media.find(filter).select('storage fileName').lean();
  for (const r of rows as Array<{ storage?: string; fileName?: string }>) if (r.storage === 'DISK') await removeMediaFile(r.fileName);
  if (!rows.length) return 0;
  const res = await Media.deleteMany({ _id: { $in: rows.map((r: any) => r._id as mongoose.Types.ObjectId) } });
  return res.deletedCount ?? 0;
}
