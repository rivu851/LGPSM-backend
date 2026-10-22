// Proves invitation cards render the way the production server runs: compiled code from dist/, the process started from
// an unrelated directory, and no assets copied next to the compiled code (the server must then find src/assets).
//   npm run build && node scripts/check-deployed-layout.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const distAssets = path.join(root, 'dist', 'assets');
const backup = fs.existsSync(distAssets) ? fs.mkdtempSync(path.join(os.tmpdir(), 'dist-assets-')) : null;
if (backup) fs.cpSync(distAssets, backup, { recursive: true });
fs.rmSync(distAssets, { recursive: true, force: true });

const probe = `
  const { renderTemplateCard, sampleTexts, TEMPLATE_DESIGNS } = require(${JSON.stringify(path.join(root, 'dist/services/cardTemplates/renderer'))});
  const { cardAssetsAvailable } = require(${JSON.stringify(path.join(root, 'dist/utils/assetPath'))});
  (async () => {
    if (!cardAssetsAvailable()) throw new Error('card assets not found from the deployed layout');
    for (const d of TEMPLATE_DESIGNS) {
      const png = await renderTemplateCard({ design: d, texts: sampleTexts(d), scale: 1 });
      if (png.length < 5000) throw new Error(d + ' rendered an empty card');
    }
    console.log('OK: all ' + TEMPLATE_DESIGNS.length + ' designs render from dist/ with assets resolved from src/assets');
  })().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
`;
const result = spawnSync(process.execPath, ['-e', probe], { cwd: os.tmpdir(), stdio: 'inherit' });

if (backup) fs.cpSync(backup, distAssets, { recursive: true });
process.exit(result.status === 0 ? 0 : 1);
