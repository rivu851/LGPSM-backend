"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mediaIdFromKey = mediaIdFromKey;
exports.isAcceptedImageKey = isAcceptedImageKey;
// Stored image references are either external URLs / site paths, or `media:<objectId>` for images
// uploaded through POST /api/v1/media/upload.
const MEDIA_KEY = /^media:([0-9a-fA-F]{24})$/;
function mediaIdFromKey(key) {
    const match = key ? MEDIA_KEY.exec(key) : null;
    return match ? match[1] : null;
}
function isAcceptedImageKey(key) {
    return MEDIA_KEY.test(key) || /^https:\/\//.test(key) || /^\/[A-Za-z0-9/_.-]+$/.test(key);
}
