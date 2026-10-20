// Copies bundled non-code assets (card artwork, fonts, logo) next to the compiled code so dist/ is self-contained.
// tsc only compiles .ts files. The server also finds src/assets when dist/assets is absent (see src/utils/assetPath.ts).
const fs = require('fs');
const path = require('path');
const from = path.join(__dirname, '..', 'src', 'assets');
const to = path.join(__dirname, '..', 'dist', 'assets');
if (fs.existsSync(from)) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  console.log('Copied assets to dist/assets');
}
