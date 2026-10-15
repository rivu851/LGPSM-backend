/**
 * One-time maintenance script: backfills `User.phone` to its normalized form
 * (see whatsapp.service.ts normalizePhoneNumber) for every existing account
 * that has a phone number stored in a legacy/raw format.
 *
 * Phone-based login (auth.service.ts) does a direct indexed lookup on the
 * *normalized* value — accounts whose phone was saved before this change was
 * introduced may still be stored un-normalized and would otherwise never be
 * found by phone until they next update their profile.
 *
 * This script is NOT wired into any npm script or CI step, and does not run
 * automatically. Run it manually, against a database you have reviewed:
 *
 *   npx tsx src/scripts/normalizePhoneNumbers.ts            # dry run (default) — reports only, writes nothing
 *   npx tsx src/scripts/normalizePhoneNumbers.ts --apply     # applies the updates
 *
 * The dry run also reports any normalized values that would collide across
 * multiple accounts (the login path already rejects ambiguous matches safely,
 * but surfacing collisions here lets an admin fix the underlying data).
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { User } from '../models/User';
import { normalizePhoneNumber } from '../services/whatsapp.service';

async function run() {
  const apply = process.argv.includes('--apply');

  await mongoose.connect(env.ATLAS_URL, { serverSelectionTimeoutMS: 10000 });

  const users = await User.find({ phone: { $exists: true, $ne: '' } }, '_id email phone').lean();

  const normalizedCounts = new Map<string, number>();
  const changes: { id: string; email: string; from: string; to: string }[] = [];

  for (const u of users) {
    const current = String(u.phone ?? '');
    const normalized = normalizePhoneNumber(current);
    if (!normalized) continue;

    normalizedCounts.set(normalized, (normalizedCounts.get(normalized) ?? 0) + 1);

    if (normalized !== current) {
      changes.push({ id: String(u._id), email: u.email, from: current, to: normalized });
    }
  }

  const collisions = [...normalizedCounts.entries()].filter(([, count]) => count > 1);

  console.log(`Scanned ${users.length} users with a phone number set.`);
  console.log(`${changes.length} would be ${apply ? 'updated' : 'updated (dry run — nothing written)'}.`);
  if (collisions.length > 0) {
    console.log(
      `WARNING: ${collisions.length} normalized phone value(s) are shared by more than one account. ` +
        'These accounts will not be reachable by phone-based login until the data is de-duplicated manually ' +
        '(the login path safely rejects an ambiguous match rather than guessing).'
    );
  }

  if (apply) {
    for (const change of changes) {
      await User.updateOne({ _id: change.id }, { $set: { phone: change.to } });
    }
    console.log(`Applied ${changes.length} update(s).`);
  } else {
    console.log('Dry run complete. Re-run with --apply to write these changes.');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('normalizePhoneNumbers failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
