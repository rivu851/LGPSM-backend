// Lays out the uploaded designs saved before the current rules (QR code in the design's own box, event wording replaced in place for admin
// uploads, nothing printed over the artwork). Each design's picture is read again; its published state is not changed.
//
//   node scripts/migrate-uploaded-layout.js            # report only: lists the uploaded designs, changes nothing
//   node scripts/migrate-uploaded-layout.js --apply    # rebuilds each design's layout
//
// Needs ATLAS_URL and a built backend (npm run build). The first design read downloads the text-recognition language file (needs internet).
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

(async () => {
  const apply = process.argv.includes('--apply');
  if (!process.env.ATLAS_URL) throw new Error('ATLAS_URL is not set');
  await mongoose.connect(process.env.ATLAS_URL);
  const { rebuildUploadedLayout } = require('../dist/services/cardTemplates/uploadedTemplate');
  const templates = mongoose.connection.collection('templates');
  const list = await templates.find({ 'templateData.uploaded': true }).project({ name: 1, templateData: 1, isPublished: 1, 'designSpec.canvas': 1 }).toArray();
  console.log(`Uploaded designs: ${list.length}`);
  for (const t of list) {
    const kind = t.templateData?.dynamicDetails ? 'admin (event wording replaced)' : 'organizer (design as it is)';
    if (!apply) { console.log(`- ${t.name} [${String(t._id)}] ${kind}, published: ${t.isPublished !== false}`); continue; }
    try {
      const r = await rebuildUploadedLayout(String(t._id));
      console.log(`- ${t.name}: done. areas: ${r.zones.join(', ') || 'none'}${r.shared ? ' · now shared with every organizer' : ''}${r.dynamic && !r.detected ? ' (the wording was not found: set its areas on the web)' : ''}`);
    } catch (e) {
      console.log(`- ${t.name}: skipped (${e.message})`);
    }
  }
  if (!apply) console.log('Nothing changed. Add --apply to rebuild them.');
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
