"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.platformSettingsController = void 0;
const platformSettings_service_1 = require("../services/platformSettings.service");
const alert_service_1 = require("../services/alert.service");
exports.platformSettingsController = {
    async getEventFeatures(_req, res, next) {
        try {
            res.status(200).json({ success: true, data: await platformSettings_service_1.platformSettingsService.getEventFeatures() });
        }
        catch (error) {
            next(error);
        }
    },
    async updateEventFeatures(req, res, next) {
        try {
            res.status(200).json({ success: true, data: await platformSettings_service_1.platformSettingsService.updateEventFeatures(req.body) });
        }
        catch (error) {
            next(error);
        }
    },
    async getNotificationPreferences(_req, res, next) {
        try {
            res.status(200).json({ success: true, data: await platformSettings_service_1.platformSettingsService.getNotificationPreferences() });
        }
        catch (error) {
            next(error);
        }
    },
    async updateNotificationPreferences(req, res, next) {
        try {
            res.status(200).json({ success: true, data: await platformSettings_service_1.platformSettingsService.updateNotificationPreferences(req.body) });
        }
        catch (error) {
            next(error);
        }
    },
    async getPricing(_req, res, next) {
        try {
            res.status(200).json({ success: true, data: await platformSettings_service_1.platformSettingsService.getPricing() });
        }
        catch (error) {
            next(error);
        }
    },
    async updatePricing(req, res, next) {
        try {
            const before = (await platformSettings_service_1.platformSettingsService.getPricing()).ratePerInvitee;
            const data = await platformSettings_service_1.platformSettingsService.updateRate(req.user.userId, req.body.ratePerInvitee);
            if (before !== data.ratePerInvitee) {
                await alert_service_1.alertService.notifyAdmins('changeInPrice', {
                    type: 'BILLING',
                    title: 'Price per invitee changed',
                    message: `The rate changed from ${before === null ? 'not set' : `${data.currency} ${before}`} to ${data.currency} ${data.ratePerInvitee}. It applies to events created from now on.`
                });
            }
            res.status(200).json({ success: true, data });
        }
        catch (error) {
            next(error);
        }
    }
};
