// Makes the Master Card the only template offered: installs it (when missing) and retires every other template, so none of them
// shows in Templates, in template selection or in "Change template" (web and app). Report only unless --apply is given.
//
//   node scripts/use-master-card-only.js            # shows what would change; changes nothing
//   node scripts/use-master-card-only.js --apply    # installs the master card and retires the others
//   node scripts/use-master-card-only.js --restore  # (with --apply) puts the retired templates back from the backup file
//
// Nothing is deleted. A retired template has isActive=false and templateData.retired=true: it is not listed, but an event that already
// uses it keeps its card exactly as it was. Their ids are written to ./retired-templates-backup.json so --restore can bring them back.
//
// Needs ATLAS_URL and a built dist/ (npm run build). An administrator account owns the master card's preview picture.
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');

const BACKUP = './retired-templates-backup.json';

(async () => {
  const apply = process.argv.includes('--apply');
  const restore = process.argv.includes('--restore');
  if (!process.env.ATLAS_URL) throw new Error('ATLAS_URL is not set');
  await mongoose.connect(process.env.ATLAS_URL);
  const templates = mongoose.connection.collection('templates');
  const users = mongoose.connection.collection('users');

  if (restore) {
    if (!fs.existsSync(BACKUP)) throw new Error(`${BACKUP} not found`);
    const ids = JSON.parse(fs.readFileSync(BACKUP, 'utf8')).map((id) => new mongoose.Types.ObjectId(id));
    console.log(`${ids.length} retired template(s) in the backup.`);
    if (apply) {
      const res = await templates.updateMany({ _id: { $in: ids } }, { $set: { isActive: true }, $unset: { 'templateData.retired': '' } });
      console.log(`Restored: ${res.modifiedCount}`);
    } else console.log('Nothing changed. Add --apply to restore them.');
    await mongoose.disconnect();
    return;
  }

  const offered = await templates.find({ isActive: { $ne: false }, cardDesign: { $ne: 'MASTER' }, $nor: [{ cardDesign: 'CUSTOM', ownerId: { $exists: true, $ne: null } }] }).project({ name: 1, cardDesign: 1, isSystemTemplate: 1 }).toArray();
  const master = await templates.countDocuments({ cardDesign: 'MASTER', isActive: { $ne: false } });
  console.log(`Master card templates now offered: ${master}`);
  console.log(`Other templates now offered (would be retired; organizers' own uploads are kept): ${offered.length}`);
  for (const t of offered) console.log(`  ${String(t._id)}  ${t.cardDesign}  ${t.name}${t.isSystemTemplate ? '  (shared)' : ''}`);

  if (!apply) {
    console.log('Nothing changed. Add --apply to install the master card and retire the others.');
    await mongoose.disconnect();
    return;
  }

  if (master === 0) {
    const admin = await users.findOne({ role: 'ADMIN', isActive: { $ne: false } }, { projection: { _id: 1 } });
    if (!admin) throw new Error('No administrator account found to own the master card');
    const { installDefaultTemplates } = require('../dist/services/cardTemplates/defaultTemplates');
    const result = await installDefaultTemplates(String(admin._id));
    console.log(`Installed: ${result.created.join(', ') || 'nothing (already present)'}`);
  }

  const previous = fs.existsSync(BACKUP) ? JSON.parse(fs.readFileSync(BACKUP, 'utf8')) : [];
  fs.writeFileSync(BACKUP, JSON.stringify([...new Set([...previous, ...offered.map((t) => String(t._id))])]));
  const res = await templates.updateMany({ _id: { $in: offered.map((t) => t._id) } }, { $set: { isActive: false, 'templateData.retired': true } });
  console.log(`Retired: ${res.modifiedCount}. Their ids are in ${BACKUP}.`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
