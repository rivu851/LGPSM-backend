// Adds the unique index that stops one organizer's staff list from holding the same e-mail twice (two requests at once used to get past
// the application's check). Staff of different organizers, and removed (inactive) staff, are outside it. This script never deletes or edits a user.
//   npm run migrate:staff-uniqueness            # report only: lists the duplicates that would block the index
//   npm run migrate:staff-uniqueness -- --apply # creates uniq_active_staff_per_owner when there are no duplicates
require('dotenv').config();
const dns = require('dns');
const mongoose = require('mongoose');

(async () => {
  if (!process.env.ATLAS_URL) throw new Error('ATLAS_URL is not set');
  try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (error) { console.warn('DNS override failed; using system defaults.'); }
  await mongoose.connect(process.env.ATLAS_URL);
  const users = mongoose.connection.collection('users');
  const duplicates = await users.aggregate([
    { $match: { role: 'SYSTEM_USER', isActive: true, createdBy: { $type: 'objectId' } } },
    { $group: { _id: { email: { $toLower: '$email' }, createdBy: '$createdBy' }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();
  if (duplicates.length) {
    console.log('Staff listed more than once for the same organizer (resolve these, then run again):');
    for (const d of duplicates) console.log(`  ${d._id.email} (organizer ${d._id.createdBy || 'none'}): ${d.ids.join(', ')}`);
    return;
  }
  console.log('No duplicate staff found.');
  if (!process.argv.includes('--apply')) { console.log('Report only. Re-run with --apply to create the index.'); return; }
  if ((await users.indexes()).some((i) => i.name === 'uniq_active_staff_per_owner')) { console.log('Index uniq_active_staff_per_owner already exists.'); return; }
  await users.createIndex({ email: 1, createdBy: 1 }, { name: 'uniq_active_staff_per_owner', unique: true, partialFilterExpression: { role: 'SYSTEM_USER', isActive: true, createdBy: { $type: 'objectId' } } });
  console.log('Created unique index uniq_active_staff_per_owner.');
})()
  .catch((error) => { console.error('Migration failed:', error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
