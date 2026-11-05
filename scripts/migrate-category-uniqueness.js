// Custom (per-organizer) categories need category names to be unique per owner instead of across everyone.
// Replaces the old plain unique index on categories.name with one unique index on { ownerId, name } (see models/Category.ts):
// the platform's own categories have no owner and stay unique among themselves; each organizer's are unique among theirs.
//
//   node scripts/migrate-category-uniqueness.js            # report only (default): changes nothing
//   node scripts/migrate-category-uniqueness.js --apply    # builds the new index, then removes the old ones
//
// Needs ATLAS_URL. Touches indexes only, never documents. Safe to run twice, and safe after an earlier version of this script
// (which could leave the collection with no unique index on names). The new index is built BEFORE the old one is removed, and
// nothing is changed if existing data would break it.
require('dotenv').config();
const mongoose = require('mongoose');

const NEW_INDEX = 'owner_scoped_name_unique';
const STALE = ['name_1', 'owner_name_unique', 'name_platform_unique'];

(async () => {
  const apply = process.argv.includes('--apply');
  if (!process.env.ATLAS_URL) throw new Error('ATLAS_URL is not set');
  await mongoose.connect(process.env.ATLAS_URL);
  const col = mongoose.connection.collection('categories');
  const names = (await col.indexes()).map((i) => i.name);
  console.log('Indexes now:', names.join(', '));

  const duplicates = await col.aggregate([
    { $group: { _id: { ownerId: { $ifNull: ['$ownerId', null] }, name: '$name' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();
  if (duplicates.length) {
    console.error(`Stopping: ${duplicates.length} name(s) appear more than once for the same owner. Nothing was changed.`);
    for (const d of duplicates) console.error(`  "${d._id.name}" x${d.count} (owner: ${d._id.ownerId || 'platform'})`);
    process.exitCode = 1;
    return;
  }

  const stale = names.filter((n) => STALE.includes(n));
  const hasNew = names.includes(NEW_INDEX);
  console.log(hasNew ? `${NEW_INDEX} is already there.` : `Would build ${NEW_INDEX}.`);
  console.log(stale.length ? `Would remove: ${stale.join(', ')}.` : 'No old indexes to remove.');
  if (!apply) { console.log('Report only. Re-run with --apply to change the indexes.'); return; }

  // An index from the earlier version of this code has the same keys and would clash with the new one; it is not the protection
  // that matters here (name_1 is, and that goes last), so it can go first.
  if (names.includes('owner_name_unique')) await col.dropIndex('owner_name_unique');
  if (!hasNew) await col.createIndex({ ownerId: 1, name: 1 }, { unique: true, name: NEW_INDEX });
  for (const n of stale) if (n !== 'owner_name_unique') await col.dropIndex(n);
  console.log('Done. Indexes now:', (await col.indexes()).map((i) => i.name).join(', '));
})()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
