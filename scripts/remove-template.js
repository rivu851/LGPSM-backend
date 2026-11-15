// Removes one template by exact name (default: the preview-less "Bday Template 1"). Report only unless --apply is given.
//
//   node scripts/remove-template.js                      # shows what matches and what uses it; changes nothing
//   node scripts/remove-template.js --apply              # deletes the match
//   node scripts/remove-template.js --name "Other name"  # another exact name
//   node scripts/remove-template.js --apply --even-if-used # also deletes it when an event points at it (that event's card then follows its event type)
//
// The deleted document is written to ./removed-templates-backup.json first, so it can be put back.
//
// Needs ATLAS_URL. Only a template with NO preview picture is eligible (that is how a broken, blank one is told from a real one), and a
// template that an event already uses is left alone unless --even-if-used is given.
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  const apply = process.argv.includes('--apply');
  const at = process.argv.indexOf('--name');
  const name = at > -1 ? process.argv[at + 1] : 'Bday Template 1';
  if (!process.env.ATLAS_URL) throw new Error('ATLAS_URL is not set');
  await mongoose.connect(process.env.ATLAS_URL);
  const templates = mongoose.connection.collection('templates');
  const events = mongoose.connection.collection('events');
  const found = await templates.find({ name }).project({ name: 1, previewImageKey: 1, isSystemTemplate: 1, isPublished: 1, isActive: 1, ownerId: 1, cardDesign: 1, kind: 1, createdAt: 1 }).toArray();
  console.log(`Templates named "${name}": ${found.length}`);
  for (const t of found) {
    const used = await events.countDocuments({ templateId: t._id });
    const eligible = !t.previewImageKey;
    console.log(JSON.stringify({ id: String(t._id), preview: t.previewImageKey || null, system: t.isSystemTemplate, published: t.isPublished, active: t.isActive, design: t.cardDesign, kind: t.kind, owner: t.ownerId ? String(t.ownerId) : null, createdAt: t.createdAt, usedByEvents: used, eligible }));
    if (!apply) continue;
    if (!eligible) { console.log('  skipped: it has a preview picture'); continue; }
    if (used > 0 && !process.argv.includes('--even-if-used')) { console.log(`  skipped: ${used} event(s) use it`); continue; }
    const full = await templates.findOne({ _id: t._id });
    require('fs').appendFileSync('removed-templates-backup.json', JSON.stringify(full) + '\n');
    const res = await templates.deleteOne({ _id: t._id });
    console.log(`  deleted: ${res.deletedCount}`);
  }
  if (!apply) console.log('Nothing changed. Add --apply to delete the eligible ones.');
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
