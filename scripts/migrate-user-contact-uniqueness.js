// Removes the legacy unique index on users.email so staff and admin accounts can share emails, and keeps ONE ORGANIZER PER EMAIL:
// a partial unique index (organizers only) replaces it. Organizer emails that are already duplicated are listed and the index is
// left for you to create once they are resolved (this script never deletes or edits a user).
//   npm run migrate:user-contact-uniqueness            # report only
//   npm run migrate:user-contact-uniqueness -- --apply # replace with a non-unique index + the organizer-only unique index
require('dotenv').config();
const dns = require('dns');
const mongoose = require('mongoose');

const isEmailIndex = (index) => {
  const keys = Object.entries(index.key || {});
  return keys.length === 1 && keys[0][0] === 'email' && keys[0][1] === 1;
};

(async () => {
  if (!process.env.ATLAS_URL) throw new Error('ATLAS_URL is not set');
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
  } catch (error) {
    console.warn('DNS override failed; using system defaults.');
  }
  await mongoose.connect(process.env.ATLAS_URL);
  const users = mongoose.connection.collection('users');
  const indexes = await users.indexes();
  const uniqueEmailIndexes = indexes.filter((index) => isEmailIndex(index) && index.unique);
  console.log('Unique email indexes:', uniqueEmailIndexes.map((index) => index.name).join(', ') || 'none');

  if (!process.argv.includes('--apply')) {
    const organizers = await users.aggregate([{ $match: { role: 'ORGANIZER' } }, { $group: { _id: { $toLower: '$email' }, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
    console.log(`Organizer emails used by more than one organizer account: ${organizers.length ? organizers.map((d) => d._id).join(', ') : 'none'}`);
    console.log('Report only. Re-run with --apply to replace the unique index.');
    return;
  }

  for (const index of uniqueEmailIndexes) await users.dropIndex(index.name);
  const remaining = await users.indexes();
  if (!remaining.some(isEmailIndex)) {
    await users.createIndex({ email: 1 }, { name: 'email_1' });
  }
  // one organizer per email
  const duplicates = await users.aggregate([
    { $match: { role: 'ORGANIZER' } },
    { $group: { _id: { $toLower: '$email' }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();
  if (duplicates.length) {
    console.log('Organizer emails used by more than one organizer account (resolve these, then run again):');
    for (const d of duplicates) console.log(`  ${d._id}: ${d.ids.join(', ')}`);
  } else if (!(await users.indexes()).some((index) => index.name === 'uniq_organizer_email')) {
    await users.createIndex({ email: 1 }, { name: 'uniq_organizer_email', unique: true, partialFilterExpression: { role: 'ORGANIZER' } });
    console.log('Created unique index uniq_organizer_email (organizers only).');
  }
  console.log('Done. User email indexes:', (await users.indexes()).filter(isEmailIndex).map((index) => `${index.name}${index.unique ? ' (unique)' : ''}`).join(', ') || 'none');
})()
  .catch((error) => { console.error('Migration failed:', error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
