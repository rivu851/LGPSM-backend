// Prepares a database for the one-active-guest-per-event-email/phone indexes.
//   npm run build
//   node scripts/migrate-invitee-uniqueness.js              # report only (default): changes nothing
//   node scripts/migrate-invitee-uniqueness.js --apply      # backfill fields and create the indexes, only if there are no conflicts
//   add --report=path.json to also write the report to a file
// Exit codes: 0 ok, 2 conflicts that need reconciling (nothing was changed), 1 error.
// It never merges, deletes or chooses between guests.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { analyzeInviteeUniqueness, applyInviteeUniqueness, connectForMigration } = require(path.join(__dirname, '..', 'dist', 'migrations', 'inviteeUniqueness'));

(async () => {
  const url = process.env.ATLAS_URL;
  if (!url) { console.error('ATLAS_URL is not set'); process.exit(1); }
  const apply = process.argv.includes('--apply');
  const reportArg = process.argv.find((a) => a.startsWith('--report='));
  await connectForMigration(url);
  const result = apply ? await applyInviteeUniqueness() : { applied: false, report: await analyzeInviteeUniqueness() };
  const out = JSON.stringify(result, null, 2);
  console.log(out);
  if (reportArg) fs.writeFileSync(reportArg.slice('--report='.length), out);
  await mongoose.disconnect();
  if (result.report.conflicts.length > 0) { console.error(`\n${result.report.conflicts.length} conflict group(s): reconcile them (edit or set aside the extra guests) and run again. Nothing was changed.`); process.exit(2); }
  if (apply && !result.applied) process.exit(1);
})().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
