# Staff uniqueness migration (`npm run migrate:staff-uniqueness`)

Adds the unique index `uniq_active_staff_per_owner` on `users` so that one organizer's staff list can never hold the same e-mail twice, even when two requests arrive at the same instant.

**The rule it enforces:** `{ email, createdBy }` is unique among accounts that are `role: SYSTEM_USER`, `isActive: true` and have an owner (`createdBy` is an ObjectId). Not affected: the same e-mail under different organizers, a staff account that shares an e-mail with an organizer or an admin, deactivated accounts, and old rows with no owner.

## What the script does

| | |
|---|---|
| Default run (no flag) | **Report only.** Lists any active staff that appear more than once for the same organizer, or says none were found. It creates nothing and changes nothing. |
| `--apply` | Repeats the check. If there are duplicates it lists them and **stops without creating the index**. If there are none it creates the index. |
| Records | Never edits, deletes or merges a user. Duplicates are resolved by a person (deactivate one in the app, or remove it by hand). |
| Re-running | Safe. If the index already exists it says so and does nothing. |
| Connection | Uses `ATLAS_URL` from the environment or `.env`. **Check which database that is before running.** |

A test (`tests/migrateStaffUniqueness.test.ts`) runs the real script against a throw-away database and checks every row above.

## Staging procedure

1. Point `ATLAS_URL` at the **staging** database (a restored copy of production is best). Print only the host name to confirm; never paste the full string anywhere.
2. Back up the collection first: `mongodump --uri "$ATLAS_URL" --db <name> --collection users --out ./backup-users-$(date +%F)`; keep it until the production run is done. (Atlas: take a snapshot instead.)
3. Report: `npm run migrate:staff-uniqueness`. Save the output.
4. If it lists duplicates: for each, decide which account is the real one, deactivate the other in the app (Remove on that staff member; their history and assignments stay), then run the report again until it says "No duplicate staff found."
5. Apply: `npm run migrate:staff-uniqueness -- --apply`. Expect "Created unique index uniq_active_staff_per_owner."
6. Verify: run it once more with `--apply` (expect "already exists"); in the app, add the same staff e-mail twice as one organizer (the second must be refused with "This person is already one of your system users."); confirm adding the same person for a different organizer still works.
7. Deploy the new backend (the application also declares the index, so a new database gets it on first start; the script exists for a database that already has data).

## Rollback

Drop the one index; no data was changed, so nothing else needs undoing:

    db.users.dropIndex("uniq_active_staff_per_owner")

The application's own duplicate check keeps working without the index (only the simultaneous-request case is then unprotected again). Restore the `users` dump only if records were edited by hand during step 4 and that has to be undone.

## If the index build fails on production

It fails only if a duplicate appeared after the report. The error names the key; run the report, resolve, run `--apply` again. Nothing is half-applied: a failed index build leaves no index.
