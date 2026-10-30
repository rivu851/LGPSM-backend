// READ-ONLY inventory of legacy (shared-token) versus separated access passes, per event. Counts only: no token, hash,
// encrypted copy, name, email or phone number is ever printed. It performs no write.
//   npm run build
//   node scripts/credential-inventory.js --confirm-host=<database host> [--report=inventory.json]
// --confirm-host must equal the host in ATLAS_URL, so the script cannot be pointed at the wrong database by accident.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { credentialInventory } = require(path.join(__dirname, '..', 'dist', 'migrations', 'credentialInventory'));

(async () => {
  const url = process.env.ATLAS_URL;
  if (!url) { console.error('ATLAS_URL is not set'); process.exit(1); }
  const host = new URL(url.replace(/^mongodb(\+srv)?:/, 'http:')).hostname;
  const arg = process.argv.find((a) => a.startsWith('--confirm-host='));
  if (!arg || arg.slice('--confirm-host='.length) !== host) {
    console.error(`Refusing to run: pass --confirm-host=${host} to confirm this is the database you mean. Nothing was read.`);
    process.exit(1);
  }
  await mongoose.connect(url, { serverSelectionTimeoutMS: 15000, readPreference: 'secondaryPreferred' });
  const out = JSON.stringify(await credentialInventory(), null, 2);
  console.log(out);
  const report = process.argv.find((a) => a.startsWith('--report='));
  if (report) fs.writeFileSync(report.slice('--report='.length), out);
  await mongoose.disconnect();
})().catch((e) => { console.error('Inventory failed:', e.message); process.exit(1); });
