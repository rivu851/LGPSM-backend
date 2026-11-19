"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extensionFor = exports.mediaDir = void 0;
exports.writeMediaFile = writeMediaFile;
exports.readMediaFile = readMediaFile;
exports.publicUrlFor = publicUrlFor;
exports.removeMediaFile = removeMediaFile;
exports.deleteMedia = deleteMedia;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const Media_1 = require("../models/Media");
// Where an uploaded image's bytes are kept.
//  - MEDIA_DIR set:    as a file in that folder (the database keeps only a small record). Point it OUTSIDE the folder the app is deployed
//                      into, or a redeploy can remove the files.
//  - MEDIA_DIR not set: inside the database (the record carries the bytes), as before.
// Images saved either way are always readable, so the setting can be changed at any time without losing anything.
const mediaDir = () => {
    const dir = (process.env.MEDIA_DIR || '').trim();
    return dir ? path_1.default.resolve(dir) : null;
};
exports.mediaDir = mediaDir;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const extensionFor = (contentType) => EXT[contentType] || 'bin';
exports.extensionFor = extensionFor;
// only plain file names made by this module are ever opened (no folders, no "..")
const safeName = (name) => (/^[0-9a-f]{24}\.(jpg|png|webp|bin)$/.test(name) ? name : null);
async function writeMediaFile(id, contentType, data) {
    const dir = (0, exports.mediaDir)();
    if (!dir)
        throw new Error('MEDIA_DIR_NOT_SET');
    await fs_1.default.promises.mkdir(dir, { recursive: true });
    const name = `${id}.${(0, exports.extensionFor)(contentType)}`;
    const target = path_1.default.join(dir, name);
    const temp = `${target}.${process.pid}.tmp`;
    // written beside the final name and renamed, so a half-written file is never served
    await fs_1.default.promises.writeFile(temp, data, { mode: 0o640 });
    await fs_1.default.promises.rename(temp, target);
    return name;
}
async function readMediaFile(fileName) {
    const dir = (0, exports.mediaDir)();
    const name = safeName(fileName);
    if (!dir || !name)
        return null;
    try {
        return await fs_1.default.promises.readFile(path_1.default.join(dir, name));
    }
    catch {
        return null;
    }
}
/** The address the file is served from when MEDIA_PUBLIC_URL is set and the file is really there; otherwise null (the API serves the bytes). */
async function publicUrlFor(fileName) {
    const base = (process.env.MEDIA_PUBLIC_URL || '').trim().replace(/\/+$/, '');
    const dir = (0, exports.mediaDir)();
    const name = fileName ? safeName(fileName) : null;
    if (!base || !/^https:\/\//i.test(base) || !dir || !name)
        return null;
    try {
        await fs_1.default.promises.access(path_1.default.join(dir, name), fs_1.default.constants.R_OK);
    }
    catch {
        return null;
    }
    return `${base}/${name}`;
}
async function removeMediaFile(fileName) {
    const dir = (0, exports.mediaDir)();
    const name = fileName ? safeName(fileName) : null;
    if (!dir || !name)
        return;
    try {
        await fs_1.default.promises.unlink(path_1.default.join(dir, name));
    }
    catch { /* already gone */ }
}
/** Deletes image records and, for the ones kept as files, the files. Same filter as Media.deleteMany. */
async function deleteMedia(filter) {
    const rows = await Media_1.Media.find(filter).select('storage fileName').lean();
    for (const r of rows)
        if (r.storage === 'DISK')
            await removeMediaFile(r.fileName);
    if (!rows.length)
        return 0;
    const res = await Media_1.Media.deleteMany({ _id: { $in: rows.map((r) => r._id) } });
    return res.deletedCount ?? 0;
}
