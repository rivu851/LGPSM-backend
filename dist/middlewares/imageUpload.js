"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadImage = uploadImage;
const multer_1 = __importDefault(require("multer"));
const media_service_1 = require("../services/media.service");
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: media_service_1.MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
        if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
            cb(null, true);
        else
            cb(new Error('Only JPG, PNG or WEBP images are supported'));
    }
}).single('file');
function uploadImage(req, res, next) {
    upload(req, res, (err) => {
        if (err instanceof multer_1.default.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ success: false, message: 'Image must be 5 MB or smaller' });
        }
        if (err)
            return res.status(400).json({ success: false, message: err.message });
        next();
    });
}
