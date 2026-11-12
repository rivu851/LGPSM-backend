"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ticketTierRoutes = exports.eventTicketTierRoutes = void 0;
const express_1 = require("express");
const ticketTier_controller_1 = require("../controllers/ticketTier.controller");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const ticketTier_validator_1 = require("../validators/ticketTier.validator");
const validate = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        return res.status(400).json({ success: false, errors: result.error.format() });
    }
    req.body = result.data;
    next();
};
exports.eventTicketTierRoutes = (0, express_1.Router)({ mergeParams: true });
// Ticket prices and sales are management data: organizer (own events) and admin only; the service checks ownership
exports.eventTicketTierRoutes.get('/', authenticate_1.authenticate, (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), ticketTier_controller_1.ticketTierController.getTicketTiers);
exports.eventTicketTierRoutes.post('/', authenticate_1.authenticate, (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), validate(ticketTier_validator_1.createTicketTierSchema), ticketTier_controller_1.ticketTierController.createTicketTier);
exports.ticketTierRoutes = (0, express_1.Router)();
exports.ticketTierRoutes.use(authenticate_1.authenticate);
exports.ticketTierRoutes.patch('/:id', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), validate(ticketTier_validator_1.updateTicketTierSchema), ticketTier_controller_1.ticketTierController.updateTicketTier);
exports.ticketTierRoutes.delete('/:id', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ORGANIZER, User_1.Role.ADMIN), ticketTier_controller_1.ticketTierController.deleteTicketTier);
