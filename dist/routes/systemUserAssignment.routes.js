"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.myAssignmentRoutes = exports.assignmentRoutes = exports.eventAssignmentRoutes = void 0;
const auditAction_1 = require("../middlewares/auditAction");
const express_1 = require("express");
const systemUserAssignment_controller_1 = require("../controllers/systemUserAssignment.controller");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const systemUserAssignment_validator_1 = require("../validators/systemUserAssignment.validator");
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
exports.eventAssignmentRoutes = (0, express_1.Router)({ mergeParams: true });
exports.eventAssignmentRoutes.use(authenticate_1.authenticate);
exports.eventAssignmentRoutes.post('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), validate(systemUserAssignment_validator_1.createAssignmentSchema), (0, auditAction_1.auditAction)({ action: 'STAFF_ASSIGN', entityType: 'SystemUserAssignment', eventParam: 'eventId' }), systemUserAssignment_controller_1.systemUserAssignmentController.createAssignment);
exports.eventAssignmentRoutes.get('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), systemUserAssignment_controller_1.systemUserAssignmentController.getAssignmentsByEvent);
exports.assignmentRoutes = (0, express_1.Router)();
exports.assignmentRoutes.use(authenticate_1.authenticate);
exports.assignmentRoutes.patch('/:assignmentId', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), validate(systemUserAssignment_validator_1.updateAssignmentSchema), (0, auditAction_1.auditAction)({ action: 'STAFF_ASSIGNMENT_UPDATE', entityType: 'SystemUserAssignment', entityParam: 'assignmentId', eventOf: 'SystemUserAssignment' }), systemUserAssignment_controller_1.systemUserAssignmentController.updateAssignment);
exports.assignmentRoutes.delete('/:assignmentId', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), (0, auditAction_1.auditAction)({ action: 'STAFF_UNASSIGN', entityType: 'SystemUserAssignment', entityParam: 'assignmentId', eventOf: 'SystemUserAssignment', critical: true }), systemUserAssignment_controller_1.systemUserAssignmentController.deleteAssignment);
exports.myAssignmentRoutes = (0, express_1.Router)();
exports.myAssignmentRoutes.use(authenticate_1.authenticate);
exports.myAssignmentRoutes.get('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.SYSTEM_USER), systemUserAssignment_controller_1.systemUserAssignmentController.getMyAssignments);
