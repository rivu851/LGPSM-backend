"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const media_controller_1 = require("../controllers/media.controller");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const media_validator_1 = require("../validators/media.validator");
const media_service_1 = require("../services/media.service");
const router = (0, express_1.Router)();
const validate = (schema) => (req, res, next) => {
    try {
        const parsed = schema.parse({ body: req.body });
        req.body = { ...req.body, ...parsed.body };
        next();
    }
    catch (err) {
        res.status(400).json({ success: false, error: 'Validation Error', message: err.issues?.[0]?.message || 'Invalid input data', details: err.issues ?? err.errors });
    }
};
const imageUpload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: media_service_1.MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
        // The real content check happens when the image is decoded; this rejects obvious non-images early
        if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
            cb(null, true);
        else
            cb(new Error('Only JPG, PNG or WEBP images are supported'));
    }
});
// S3 presigned upload (used when object storage is configured)
router.post('/presign', authenticate_1.authenticate, (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER), validate(media_validator_1.presignMediaSchema), media_controller_1.mediaController.presign);
// Direct upload stored by the API; the purpose decides which roles may upload
router.post('/upload', authenticate_1.authenticate, (req, res, next) => {
    imageUpload.single('file')(req, res, (err) => {
        if (err instanceof multer_1.default.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ success: false, message: 'Image must be 5 MB or smaller' });
        }
        if (err)
            return res.status(400).json({ success: false, message: err.message });
        next();
    });
}, media_controller_1.mediaController.upload);
router.get('/:id', media_controller_1.mediaController.serve);
exports.default = router;
