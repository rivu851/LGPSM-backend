"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inviteeRoutes = exports.eventInviteeRoutes = void 0;
const express_1 = require("express");
const invitee_controller_1 = require("../controllers/invitee.controller");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const invitee_validator_1 = require("../validators/invitee.validator");
const multer_1 = __importDefault(require("multer"));
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const excelMime = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'].includes(file.mimetype);
        // Some browsers send spreadsheets as a generic binary; the parser still validates the content
        const excelByName = file.mimetype === 'application/octet-stream' && /\.(xlsx|xls)$/i.test(file.originalname);
        if (excelMime || excelByName) {
            cb(null, true);
        }
        else {
            cb(new Error('Upload an Excel file (.xlsx or .xls)'));
        }
    }
});
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
exports.eventInviteeRoutes = (0, express_1.Router)({ mergeParams: true });
exports.eventInviteeRoutes.use(authenticate_1.authenticate);
exports.eventInviteeRoutes.post('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), validate(invitee_validator_1.createInviteeSchema), invitee_controller_1.inviteeController.createInvitee);
// SYSTEM_USER may read invitees of events they are assigned to (for check-in)
exports.eventInviteeRoutes.get('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER, User_1.Role.SYSTEM_USER), invitee_controller_1.inviteeController.getInvitees);
exports.eventInviteeRoutes.put('/session-access/bulk', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), validate(invitee_validator_1.bulkUpdateSessionAccessSchema), invitee_controller_1.inviteeController.bulkUpdateSessionAccess);
// Upload handling
exports.eventInviteeRoutes.post('/import', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err instanceof multer_1.default.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: 'Payload Too Large', message: 'File size exceeds limit', details: [] });
            }
            return res.status(400).json({ error: 'Bad Request', message: err.message, details: [] });
        }
        else if (err) {
            return res.status(415).json({ error: 'Unsupported Media Type', message: err.message, details: [] });
        }
        next();
    });
}, invitee_controller_1.inviteeController.importExcel);
exports.inviteeRoutes = (0, express_1.Router)();
exports.inviteeRoutes.use(authenticate_1.authenticate);
exports.inviteeRoutes.get('/:inviteeId', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), invitee_controller_1.inviteeController.getInviteeById);
exports.inviteeRoutes.patch('/:inviteeId', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), validate(invitee_validator_1.updateInviteeSchema), invitee_controller_1.inviteeController.updateInvitee);
exports.inviteeRoutes.delete('/:inviteeId', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), invitee_controller_1.inviteeController.deleteInvitee);
exports.inviteeRoutes.put('/:inviteeId/session-access', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), validate(invitee_validator_1.updateSessionAccessSchema), invitee_controller_1.inviteeController.updateSessionAccess);
