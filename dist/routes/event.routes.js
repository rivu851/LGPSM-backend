"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auditAction_1 = require("../middlewares/auditAction");
const express_1 = require("express");
const event_controller_1 = require("../controllers/event.controller");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const event_validator_1 = require("../validators/event.validator");
const router = (0, express_1.Router)();
// Zod validation middleware wrapper
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
// All event routes require authentication
router.use(authenticate_1.authenticate);
// Cleanup route - ADMIN ONLY
router.post('/:eventId/cleanup', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), (0, auditAction_1.auditAction)({ action: 'EVENT_PURGE', entityType: 'Event', entityParam: 'eventId', critical: true, describe: 'Permanent deletion of event operational data', meta: (_r, b) => ({ cleanedCounts: b?.cleanedCounts }) }), event_controller_1.eventController.cleanupEventData);
// Close (complete) an event without deleting anything - ADMIN or the owning ORGANIZER
// Change when guests may be admitted (allowed after invitations went out; audited, fails closed)
router.patch('/:eventId/admission', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), validate(event_validator_1.updateAdmissionSchema), (0, auditAction_1.auditAction)({ action: 'EVENT_ADMISSION_UPDATE', entityType: 'Event', entityParam: 'eventId', critical: true, describe: 'Check-in window changed', meta: (req) => ({ opensAt: req.body?.opensAt, closesAt: req.body?.closesAt }) }), event_controller_1.eventController.updateAdmission);
router.post('/:eventId/close', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), (0, auditAction_1.auditAction)({ action: 'EVENT_CLOSE', entityType: 'Event', entityParam: 'eventId', critical: true, describe: 'Event closed (data retained)' }), event_controller_1.eventController.closeEvent);
// Routes accessible to ADMIN and ORGANIZER
router.post('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), validate(event_validator_1.createEventSchema), (0, auditAction_1.auditAction)({ action: 'EVENT_CREATE', entityType: 'Event' }), event_controller_1.eventController.createEvent);
router.get('/', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), event_controller_1.eventController.getEvents);
// SYSTEM_USER may read details of events they are assigned to (for check-in)
router.get('/:eventId', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER, User_1.Role.SYSTEM_USER), event_controller_1.eventController.getEventById);
router.patch('/:eventId', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), validate(event_validator_1.updateEventSchema), (0, auditAction_1.auditAction)({ action: 'EVENT_UPDATE', entityType: 'Event', entityParam: 'eventId' }), event_controller_1.eventController.updateEvent);
// Cancel (terminal, notifies invited guests). DELETE is the same operation for older clients; nothing is ever deleted by it.
const cancelAudit = (0, auditAction_1.auditAction)({ action: 'EVENT_CANCEL', entityType: 'Event', entityParam: 'eventId', critical: true, describe: 'Event cancelled', meta: (req, body) => ({ reason: req.body?.reason, notices: body?.data?.notices, alreadyCancelled: body?.data?.alreadyCancelled }) });
router.post('/:eventId/cancel', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), cancelAudit, event_controller_1.eventController.cancelEvent);
router.delete('/:eventId', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), cancelAudit, event_controller_1.eventController.cancelEvent);
// What cancelling would do, and what happened afterwards (organizer / admin only)
router.get('/:eventId/cancellation/preview', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), event_controller_1.eventController.getCancellationPreview);
router.get('/:eventId/cancellation/notices', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), event_controller_1.eventController.getCancellationNotices);
router.post('/:eventId/cancellation/notices/retry', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), (0, auditAction_1.auditAction)({ action: 'EVENT_CANCEL_NOTICES_RETRY', entityType: 'Event', entityParam: 'eventId', describe: 'Cancellation notices retried', meta: (req) => ({ includeUnknown: req.body?.includeUnknown === true }) }), event_controller_1.eventController.retryCancellationNotices);
exports.default = router;
