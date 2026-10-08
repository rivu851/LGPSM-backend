"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authenticate_1 = require("../middlewares/authenticate");
const authorizeRoles_1 = require("../middlewares/authorizeRoles");
const User_1 = require("../models/User");
const platformSettings_controller_1 = require("../controllers/platformSettings.controller");
const platformSettings_validator_1 = require("../validators/platformSettings.validator");
const validate = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        return res.status(400).json({ success: false, message: result.error.issues[0]?.message || 'Invalid input data' });
    }
    req.body = result.data;
    next();
};
const router = (0, express_1.Router)();
router.use(authenticate_1.authenticate);
// Organizers read event features so the event form only offers what the admin allows
router.get('/event-features', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN, User_1.Role.ORGANIZER), platformSettings_controller_1.platformSettingsController.getEventFeatures);
router.put('/event-features', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), validate(platformSettings_validator_1.eventFeaturesSchema), platformSettings_controller_1.platformSettingsController.updateEventFeatures);
router.get('/notifications', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), platformSettings_controller_1.platformSettingsController.getNotificationPreferences);
router.put('/notifications', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), validate(platformSettings_validator_1.notificationPreferencesSchema), platformSettings_controller_1.platformSettingsController.updateNotificationPreferences);
router.get('/pricing', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), platformSettings_controller_1.platformSettingsController.getPricing);
router.put('/pricing', (0, authorizeRoles_1.authorizeRoles)(User_1.Role.ADMIN), validate(platformSettings_validator_1.pricingSchema), platformSettings_controller_1.platformSettingsController.updatePricing);
exports.default = router;
