"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.shapePreview = shapePreview;
const sharp_1 = __importDefault(require("sharp"));
/**
 * On-screen previews do not need the full-size PNG the card is drawn as (about 1.4 MB). A caller may ask for a smaller copy
 * with `?width=<80-1600>` and/or `?format=webp`; the same card as WebP at preview width is a small fraction of the size.
 * Anything else about the request is ignored and the PNG is returned untouched, so emailed cards and downloads never change.
 */
async function shapePreview(png, query) {
    const widthRaw = Number(Array.isArray(query.width) ? query.width[0] : query.width);
    const width = Number.isFinite(widthRaw) ? Math.min(1600, Math.max(80, Math.round(widthRaw))) : null;
    const webp = (Array.isArray(query.format) ? query.format[0] : query.format) === 'webp';
    if (!width && !webp)
        return { body: png, contentType: 'image/png' };
    let image = (0, sharp_1.default)(png);
    if (width)
        image = image.resize({ width, withoutEnlargement: true });
    return webp
        ? { body: await image.webp({ quality: 82 }).toBuffer(), contentType: 'image/webp' }
        : { body: await image.png({ compressionLevel: 9 }).toBuffer(), contentType: 'image/png' };
}
