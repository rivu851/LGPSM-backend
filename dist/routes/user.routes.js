"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const user_controller_1 = require("../controllers/user.controller");
const authenticate_1 = require("../middlewares/authenticate");
const user_validator_1 = require("../validators/user.validator");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
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
router.patch('/me/password', validate(user_validator_1.changePasswordSchema), user_controller_1.userController.changePassword);
// Endpoint for Admins and Organizers to list users (supports ?role=SYSTEM_USER)
router.get('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), user_controller_1.userController.getUsers);
// Endpoint for Admins and Organizers to create sub-users
router.post('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), validate(user_validator_1.createUserSchema), user_controller_1.userController.createUser);
// Endpoint for Admins and Organizers to delete sub-users
router.delete('/:id', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), user_controller_1.userController.deleteUser);
// Endpoint for Admins and Organizers to update sub-users
router.patch('/:id', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), validate(user_validator_1.updateUserSchema), user_controller_1.userController.updateUser);
// Admin/organizer view of a staff member's event/session assignments
// (organizers only ever see assignments scoped to their own events; see service)
router.get('/:id/assignments', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), user_controller_1.userController.getUserAssignments);
exports.default = router;
