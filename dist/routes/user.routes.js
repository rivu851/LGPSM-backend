"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auditAction_1 = require("../middlewares/auditAction");
const zod_1 = require("zod");
const User_1 = require("../models/User");
const platformSettings_service_1 = require("../services/platformSettings.service");
const express_1 = require("express");
const user_controller_1 = require("../controllers/user.controller");
const authenticate_1 = require("../middlewares/authenticate");
const user_validator_1 = require("../validators/user.validator");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_2 = require("../models/User");
const imageUpload_1 = require("../middlewares/imageUpload");
const rateLimiter_1 = require("../middlewares/rateLimiter");
const router = (0, express_1.Router)();
const validate = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        return res.status(400).json({ success: false, errors: result.error.format() });
    }
    req.body = result.data;
    next();
};
// All user routes require authentication
router.use(authenticate_1.authenticate);
router.get('/profile', user_controller_1.userController.getProfile);
router.patch('/profile', validate(user_validator_1.updateProfileSchema), user_controller_1.userController.updateProfile);
router.patch('/profile/photo', rateLimiter_1.mediaUploadLimiter, imageUpload_1.uploadImage, user_controller_1.userController.updateProfilePhoto);
router.patch('/me/password', validate(user_validator_1.changePasswordSchema), (0, auditAction_1.auditAction)({ action: 'USER_PASSWORD_CHANGE', entityType: 'User' }), user_controller_1.userController.changePassword);
// Endpoint for Admins and Organizers to list users (supports ?role=SYSTEM_USER)
router.get('/', (0, authorizeRoles_1.authorizeRoles)(User_2.Role.ADMIN, User_2.Role.ORGANIZER), user_controller_1.userController.getUsers);
// Endpoint for Admins and Organizers to create sub-users
router.post('/', (0, authorizeRoles_1.authorizeRoles)(User_2.Role.ADMIN, User_2.Role.ORGANIZER), validate(user_validator_1.createUserSchema), (0, auditAction_1.auditAction)({ action: 'USER_CREATE', entityType: 'User' }), user_controller_1.userController.createUser);
// Endpoint for Admins and Organizers to view a single sub-user
router.get('/:id', (0, authorizeRoles_1.authorizeRoles)(User_2.Role.ADMIN, User_2.Role.ORGANIZER), user_controller_1.userController.getUserById);
// Endpoint for Admins and Organizers to delete sub-users
router.delete('/:id', (0, authorizeRoles_1.authorizeRoles)(User_2.Role.ADMIN, User_2.Role.ORGANIZER), (0, auditAction_1.auditAction)({ action: 'USER_DELETE', entityType: 'User', entityParam: 'id', critical: true }), user_controller_1.userController.deleteUser);
// Endpoint for Admins and Organizers to update sub-users
router.patch('/:id', (0, authorizeRoles_1.authorizeRoles)(User_2.Role.ADMIN, User_2.Role.ORGANIZER), validate(user_validator_1.updateUserSchema), (0, auditAction_1.auditAction)({ action: 'USER_UPDATE', entityType: 'User', entityParam: 'id' }), user_controller_1.userController.updateUser);
// The per-invitee rate for one organizer: their own rate when an administrator set one, otherwise the platform rate
router.get('/:id/rate', (0, authorizeRoles_1.authorizeRoles)(User_2.Role.ADMIN), async (req, res, next) => {
    try {
        res.json({ success: true, data: await platformSettings_service_1.platformSettingsService.rateForOrganizer(req.params.id) });
    }
    catch (e) {
        next(e);
    }
});
router.put('/:id/rate', (0, authorizeRoles_1.authorizeRoles)(User_2.Role.ADMIN), validate(zod_1.z.object({ ratePerInvitee: zod_1.z.number().finite().min(0, 'Rate cannot be negative').max(1000, 'Rate looks too high').nullable() }).strict()), (0, auditAction_1.auditAction)({ action: 'ORGANIZER_RATE_SET', entityType: 'User', entityParam: 'id' }), async (req, res, next) => {
    try {
        const target = await User_1.User.findOne({ _id: req.params.id, role: User_2.Role.ORGANIZER }).select('_id').lean();
        if (!target)
            return res.status(404).json({ success: false, message: 'Organizer not found' });
        res.json({ success: true, data: await platformSettings_service_1.platformSettingsService.setOrganizerRate(req.user.userId, String(req.params.id), req.body.ratePerInvitee) });
    }
    catch (e) {
        next(e);
    }
});
// Admin/organizer view of a staff member's event/session assignments
// (organizers only ever see assignments scoped to their own events; see service)
router.get('/:id/assignments', (0, authorizeRoles_1.authorizeRoles)(User_2.Role.ADMIN, User_2.Role.ORGANIZER), user_controller_1.userController.getUserAssignments);
exports.default = router;
