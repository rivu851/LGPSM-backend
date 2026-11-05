#!/usr/bin/env node
/*
 * Custom (per-organizer) categories need category names to be unique per owner instead of globally.
 * Replaces the old plain unique index on categories.name with two partial unique indexes (see models/Category.ts).
 *
 *   node scripts/migrate-category-uniqueness.js          # shows what it would do
 *   node scripts/migrate-category-uniqueness.js --apply  # does it
 *
 * Needs ATLAS_URL. Touches indexes only, never documents. Safe to run twice.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const apply = process.argv.includes('--apply');
  if (!process.env.ATLAS_URL) throw new Error('ATLAS_URL is not set');
  await mongoose.connect(process.env.ATLAS_URL);
  const col = mongoose.connection.collection('categories');
  const indexes = await col.indexes();
  const old = indexes.find((i) => i.name === 'name_1' && i.unique);
  console.log(old ? 'Found the old unique index on name.' : 'No old unique index on name (nothing to drop).');
  if (!apply) { console.log('Dry run. Re-run with --apply to change indexes.'); return; }
  if (old) await col.dropIndex('name_1');
  await col.createIndex({ name: 1 }, { unique: true, partialFilterExpression: { ownerId: { $exists: false } }, name: 'name_platform_unique' });
  await col.createIndex({ ownerId: 1, name: 1 }, { unique: true, partialFilterExpression: { ownerId: { $exists: true } }, name: 'owner_name_unique' });
  console.log('Done.');
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
