"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assetPath = assetPath;
exports.cardAssetsAvailable = cardAssetsAvailable;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// Bundled assets (card artwork, fonts, logo) live in src/assets. The compiler does not copy non-code files, and the
// deployed server runs the compiled code from dist/, so the same code must find them from either layout:
//
//   development / tests : <repo>/src/utils/..   -> <repo>/src/assets
//   deployed (Render)   : <repo>/dist/utils/..  -> <repo>/dist/assets (if the build copied them)
//                                               -> <repo>/src/assets  (the repository is deployed whole)
const CANDIDATES = [
    path_1.default.join(__dirname, '../assets'), // next to the running code (src/ in development, dist/ when copied)
    path_1.default.join(__dirname, '../../src/assets'), // dist/ -> the repository's src/
    path_1.default.join(process.cwd(), 'src/assets'), // last resort: the process was started from the repository root
];
let resolved = null;
/** Absolute path of a bundled asset, e.g. assetPath('cardTemplates', 'fonts', 'Inter-Bold.ttf'). */
function assetPath(...segments) {
    if (resolved === null) {
        resolved = CANDIDATES.find((dir) => fs_1.default.existsSync(path_1.default.join(dir, 'cardTemplates'))) ?? '';
        if (!resolved) {
            console.error('[assets] Card assets not found. Looked in:', CANDIDATES.join(' | '));
            resolved = CANDIDATES[0];
        }
    }
    return path_1.default.join(resolved, ...segments);
}
/** True when the card artwork and fonts can be found (used by start-up checks and health reporting). */
function cardAssetsAvailable() {
    return fs_1.default.existsSync(assetPath('cardTemplates', 'fonts')) && fs_1.default.existsSync(assetPath('cardTemplates', 'birthday', 'background.png'));
}
