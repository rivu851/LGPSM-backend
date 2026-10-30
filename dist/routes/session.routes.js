"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionRoutes = exports.eventSessionRoutes = void 0;
const auditAction_1 = require("../middlewares/auditAction");
const express_1 = require("express");
const session_controller_1 = require("../controllers/session.controller");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const session_validator_1 = require("../validators/session.validator");
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
exports.eventSessionRoutes = (0, express_1.Router)({ mergeParams: true });
exports.eventSessionRoutes.use(authenticate_1.authenticate);
exports.eventSessionRoutes.post('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), validate(session_validator_1.createSessionSchema), (0, auditAction_1.auditAction)({ action: 'SESSION_CREATE', entityType: 'Session', eventParam: 'eventId' }), session_controller_1.sessionController.createSession);
// SYSTEM_USER may read the sessions of events they are assigned to (for check-in)
exports.eventSessionRoutes.get('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER, User_1.Role.SYSTEM_USER), session_controller_1.sessionController.getSessions);
exports.sessionRoutes = (0, express_1.Router)();
exports.sessionRoutes.use(authenticate_1.authenticate);
exports.sessionRoutes.get('/:sessionId', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), session_controller_1.sessionController.getSessionById);
exports.sessionRoutes.patch('/:sessionId', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), validate(session_validator_1.updateSessionSchema), (0, auditAction_1.auditAction)({ action: 'SESSION_UPDATE', entityType: 'Session', entityParam: 'sessionId', eventOf: 'Session' }), session_controller_1.sessionController.updateSession);
exports.sessionRoutes.delete('/:sessionId', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), (0, auditAction_1.auditAction)({ action: 'SESSION_DELETE', entityType: 'Session', entityParam: 'sessionId', eventOf: 'Session', critical: true }), session_controller_1.sessionController.deleteSession);
