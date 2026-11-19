// Moves uploaded images between the database and the MEDIA_DIR folder. Nothing is ever deleted before its copy is verified.
//
//   node scripts/migrate-media-storage.js to-disk            # report only (default)
//   node scripts/migrate-media-storage.js to-disk --apply    # database -> files in MEDIA_DIR (the bytes are removed from the record afterwards)
//   node scripts/migrate-media-storage.js to-db --apply      # files in MEDIA_DIR -> database (the files are kept)
//
// Needs ATLAS_URL and, for to-disk, MEDIA_DIR. Safe to run twice: images already in the target place are skipped. Use the same
// compiled models as the server, so run it after `npm run build`.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Media } = require('../dist/models/Media');

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

(async () => {
  const direction = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!['to-disk', 'to-db'].includes(direction)) throw new Error('Say which way: to-disk or to-db');
  if (!process.env.ATLAS_URL) throw new Error('ATLAS_URL is not set');
  const dir = (process.env.MEDIA_DIR || '').trim() ? path.resolve(process.env.MEDIA_DIR) : null;
  if (!dir) throw new Error('MEDIA_DIR is not set');
  await mongoose.connect(process.env.ATLAS_URL);

  const from = direction === 'to-disk' ? 'DB' : 'DISK';
  const filter = from === 'DB' ? { $or: [{ storage: 'DB' }, { storage: { $exists: false } }] } : { storage: 'DISK' };
  const ids = (await Media.find(filter).select('_id size').lean());
  const bytes = ids.reduce((n, m) => n + (m.size || 0), 0);
  console.log(`${ids.length} image(s) kept ${from === 'DB' ? 'in the database' : 'as files'} (${(bytes / 1048576).toFixed(1)} MB).`);
  if (!apply) { console.log('Report only. Re-run with --apply to move them.'); await mongoose.disconnect(); return; }

  if (direction === 'to-disk') await fs.promises.mkdir(dir, { recursive: true });
  let moved = 0, failed = 0;
  for (const { _id } of ids) {
    try {
      const m = await Media.findById(_id).select('+data contentType storage fileName');
      if (!m) continue;
      if (direction === 'to-disk') {
        if (!m.data) { failed++; console.error(`${_id}: no bytes in the record, skipped`); continue; }
        const name = `${_id}.${EXT[m.contentType] || 'bin'}`;
        const target = path.join(dir, name);
        await fs.promises.writeFile(target + '.tmp', m.data); await fs.promises.rename(target + '.tmp', target);
        const check = await fs.promises.readFile(target);
        if (!check.equals(m.data)) { failed++; console.error(`${_id}: the copy does not match, left in the database`); continue; }
        await Media.updateOne({ _id }, { $set: { storage: 'DISK', fileName: name }, $unset: { data: '' } });
      } else {
        const buf = await fs.promises.readFile(path.join(dir, m.fileName));
        await Media.updateOne({ _id }, { $set: { storage: 'DB', data: buf }, $unset: { fileName: '' } });
      }
      moved++;
    } catch (err) { failed++; console.error(`${_id}: ${err.message}`); }
  }
  console.log(`Moved ${moved}, failed ${failed}.`);
  await mongoose.disconnect();
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
