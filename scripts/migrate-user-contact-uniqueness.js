// Removes the legacy unique index on users.email so accounts can share emails.
//   npm run migrate:user-contact-uniqueness            # report only
//   npm run migrate:user-contact-uniqueness -- --apply # replace with a non-unique index
require('dotenv').config();
const mongoose = require('mongoose');

const isEmailIndex = (index) => {
  const keys = Object.entries(index.key || {});
  return keys.length === 1 && keys[0][0] === 'email' && keys[0][1] === 1;
};

(async () => {
  if (!process.env.ATLAS_URL) throw new Error('ATLAS_URL is not set');
  await mongoose.connect(process.env.ATLAS_URL);
  const users = mongoose.connection.collection('users');
  const indexes = await users.indexes();
  const uniqueEmailIndexes = indexes.filter((index) => isEmailIndex(index) && index.unique);
  console.log('Unique email indexes:', uniqueEmailIndexes.map((index) => index.name).join(', ') || 'none');

  if (!process.argv.includes('--apply')) {
    console.log('Report only. Re-run with --apply to replace the unique index.');
    return;
  }

  for (const index of uniqueEmailIndexes) await users.dropIndex(index.name);
  const remaining = await users.indexes();
  if (!remaining.some(isEmailIndex)) {
    await users.createIndex({ email: 1 }, { name: 'email_1' });
  }
  console.log('Done. User email indexes:', (await users.indexes()).filter(isEmailIndex).map((index) => `${index.name}${index.unique ? ' (unique)' : ''}`).join(', ') || 'none');
})()
  .catch((error) => { console.error('Migration failed:', error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
