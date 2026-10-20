import fs from 'fs';
import path from 'path';

// Bundled assets (card artwork, fonts, logo) live in src/assets. The compiler does not copy non-code files, and the
// deployed server runs the compiled code from dist/, so the same code must find them from either layout:
//
//   development / tests : <repo>/src/utils/..   -> <repo>/src/assets
//   deployed (Render)   : <repo>/dist/utils/..  -> <repo>/dist/assets (if the build copied them)
//                                               -> <repo>/src/assets  (the repository is deployed whole)
const CANDIDATES = [
  path.join(__dirname, '../assets'), // next to the running code (src/ in development, dist/ when copied)
  path.join(__dirname, '../../src/assets'), // dist/ -> the repository's src/
  path.join(process.cwd(), 'src/assets'), // last resort: the process was started from the repository root
];

let resolved: string | null = null;

/** Absolute path of a bundled asset, e.g. assetPath('cardTemplates', 'fonts', 'Inter-Bold.ttf'). */
export function assetPath(...segments: string[]): string {
  if (resolved === null) {
    resolved = CANDIDATES.find((dir) => fs.existsSync(path.join(dir, 'cardTemplates'))) ?? '';
    if (!resolved) {
      console.error('[assets] Card assets not found. Looked in:', CANDIDATES.join(' | '));
      resolved = CANDIDATES[0];
    }
  }
  return path.join(resolved, ...segments);
}

/** True when the card artwork and fonts can be found (used by start-up checks and health reporting). */
export function cardAssetsAvailable(): boolean {
  return fs.existsSync(assetPath('cardTemplates', 'fonts')) && fs.existsSync(assetPath('cardTemplates', 'birthday', 'background.png'));
}
