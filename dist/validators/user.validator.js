"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.changePasswordSchema = exports.updateUserSchema = exports.createUserSchema = exports.updateProfileSchema = void 0;
const zod_1 = require("zod");
const User_1 = require("../models/User");
exports.updateProfileSchema = zod_1.z.object({
    fullName: zod_1.z.string().min(2, 'Full name must be at least 2 characters').optional(),
    phone: zod_1.z.string().optional(),
    profile: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional()
}).strict();
exports.createUserSchema = zod_1.z.object({
    fullName: zod_1.z.string().min(2, 'Full name must be at least 2 characters'),
    email: zod_1.z.string().email('Invalid email address'),
    password: zod_1.z.string().min(6, 'Password must be at least 6 characters'),
    phone: zod_1.z.string().optional(),
    role: zod_1.z.enum([User_1.Role.ADMIN, User_1.Role.ORGANIZER, User_1.Role.SYSTEM_USER]),
    profile: zod_1.z.object({
        organizationName: zod_1.z.string().max(150).optional()
    }).strict().optional()
}).strict();
exports.updateUserSchema = zod_1.z.object({
    fullName: zod_1.z.string().min(2, 'Full name must be at least 2 characters').optional(),
    email: zod_1.z.string().email('Invalid email address').optional(),
    phone: zod_1.z.string().optional(),
    password: zod_1.z.string().min(6, 'Password must be at least 6 characters').optional(),
    isActive: zod_1.z.boolean().optional()
}).strict();
exports.changePasswordSchema = zod_1.z.object({
    currentPassword: zod_1.z.string().min(1, 'Current password is required'),
    newPassword: zod_1.z.string().min(8, 'New password must be at least 8 characters')
}).strict();
