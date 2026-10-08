"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userController = void 0;
const user_service_1 = require("../services/user.service");
const systemUserAssignment_service_1 = require("../services/systemUserAssignment.service");
exports.userController = {
    async getProfile(req, res, next) {
        try {
            if (!req.user)
                throw { statusCode: 401, message: 'Unauthorized' };
            const user = await user_service_1.userService.getProfile(req.user.userId);
            res.status(200).json({ success: true, data: user });
        }
        catch (error) {
            next(error);
        }
    },
    async updateProfile(req, res, next) {
        try {
            if (!req.user)
                throw { statusCode: 401, message: 'Unauthorized' };
            const user = await user_service_1.userService.updateProfile(req.user.userId, req.body);
            res.status(200).json({ success: true, data: user });
        }
        catch (error) {
            next(error);
        }
    },
    async changePassword(req, res, next) {
        try {
            if (!req.user)
                throw { statusCode: 401, message: 'Unauthorized' };
            const result = await user_service_1.userService.changePassword(req.user.userId, req.body.currentPassword, req.body.newPassword);
            res.status(200).json({ success: true, data: result, message: 'Password updated successfully' });
        }
        catch (error) {
            next(error);
        }
    },
    async createUser(req, res, next) {
        try {
            if (!req.user)
                throw { statusCode: 401, message: 'Unauthorized' };
            const user = await user_service_1.userService.createUser(req.user, req.body);
            res.status(201).json({ success: true, data: user });
        }
        catch (error) {
            next(error);
        }
    },
    async getUsers(req, res, next) {
        try {
            if (!req.user)
                throw { statusCode: 401, message: 'Unauthorized' };
            const roleFilter = req.query.role;
            const includeInactive = req.query.includeInactive === 'true';
            const users = await user_service_1.userService.getUsers(req.user, roleFilter, includeInactive);
            res.status(200).json({ success: true, data: users });
        }
        catch (error) {
            next(error);
        }
    },
    async getUserAssignments(req, res, next) {
        try {
            if (!req.user)
                throw { statusCode: 401, message: 'Unauthorized' };
            const assignments = await systemUserAssignment_service_1.systemUserAssignmentService.getAssignmentsByUser(req.params.id, req.user);
            res.status(200).json({ success: true, data: assignments });
        }
        catch (error) {
            next(error);
        }
    },
    async deleteUser(req, res, next) {
        try {
            if (!req.user)
                throw { statusCode: 401, message: 'Unauthorized' };
            const result = await user_service_1.userService.deleteUser(req.user, req.params.id);
            res.status(200).json({ success: true, data: result });
        }
        catch (error) {
            next(error);
        }
    },
    async updateUser(req, res, next) {
        try {
            if (!req.user)
                throw { statusCode: 401, message: 'Unauthorized' };
            const user = await user_service_1.userService.updateUser(req.user, req.params.id, req.body);
            res.status(200).json({ success: true, data: user });
        }
        catch (error) {
            next(error);
        }
    }
};
