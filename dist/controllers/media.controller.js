"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mediaController = void 0;
const media_service_1 = require("../services/media.service");
const Media_1 = require("../models/Media");
const User_1 = require("../models/User");
// Which roles may upload each kind of image
const UPLOAD_ROLES = {
    [Media_1.MediaPurpose.TEMPLATE]: [User_1.Role.ADMIN],
    [Media_1.MediaPurpose.EVENT_LOGO]: [User_1.Role.ADMIN, User_1.Role.ORGANIZER],
    [Media_1.MediaPurpose.ORGANIZATION_LOGO]: [User_1.Role.ADMIN, User_1.Role.ORGANIZER],
    [Media_1.MediaPurpose.AVATAR]: [User_1.Role.ADMIN, User_1.Role.ORGANIZER, User_1.Role.SYSTEM_USER]
};
exports.mediaController = {
    async presign(req, res, next) {
        try {
            const { fileName, fileType } = req.body;
            const result = await media_service_1.mediaService.generatePresignedUrl(fileName, fileType);
            res.status(200).json({
                success: true,
                data: result
            });
        }
        catch (error) {
            next(error);
        }
    },
    async upload(req, res, next) {
        try {
            const purpose = String(req.body?.purpose || '');
            if (!Object.values(Media_1.MediaPurpose).includes(purpose)) {
                return res.status(400).json({ success: false, message: 'A valid upload purpose is required' });
            }
            const actor = req.user;
            if (!UPLOAD_ROLES[purpose].includes(actor.role)) {
                return res.status(403).json({ success: false, message: 'You are not allowed to upload this kind of image' });
            }
            const file = req.file;
            if (!file) {
                return res.status(400).json({ success: false, message: 'Attach an image file' });
            }
            const stored = await media_service_1.mediaService.storeImage(actor.userId, purpose, file.buffer, file.originalname);
            res.status(201).json({ success: true, data: stored });
        }
        catch (error) {
            next(error);
        }
    },
    // Public: stored images back event cards, templates and invitation pages viewed by guests
    async serve(req, res, next) {
        try {
            const media = await media_service_1.mediaService.getImage(String(req.params.id));
            if (!media) {
                return res.status(404).json({ success: false, message: 'Image not found' });
            }
            res.setHeader('Content-Type', media.contentType);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.status(200).send(media.data);
        }
        catch (error) {
            next(error);
        }
    }
};
