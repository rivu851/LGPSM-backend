"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const media_controller_1 = require("../controllers/media.controller");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const media_validator_1 = require("../validators/media.validator");
const rateLimiter_1 = require("../middlewares/rateLimiter");
const imageUpload_1 = require("../middlewares/imageUpload");
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
// S3 presigned upload (used when object storage is configured)
router.post('/presign', authenticate_1.authenticate, (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER), validate(media_validator_1.presignMediaSchema), media_controller_1.mediaController.presign);
// Direct upload stored by the API; the purpose decides which roles may upload
router.post('/upload', authenticate_1.authenticate, rateLimiter_1.mediaUploadLimiter, imageUpload_1.uploadImage, media_controller_1.mediaController.upload);
router.get('/:id', media_controller_1.mediaController.serve);
exports.default = router;
