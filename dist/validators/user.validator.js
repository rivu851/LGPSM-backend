"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.changePasswordSchema = exports.updateUserSchema = exports.createUserSchema = exports.updateProfileSchema = void 0;
const zod_1 = require("zod");
const User_1 = require("../models/User");
exports.updateProfileSchema = zod_1.z.object({
    fullName: zod_1.z.string().min(2, 'Full name must be at least 2 characters').optional(),
    phone: zod_1.z.string().optional(),
    profile: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional(),
    // The organizer's organization, kept apart from their personal details (name, phone). Organizers and admins only.
    organization: zod_1.z.object({
        name: zod_1.z.string().trim().min(1, 'Organization name is required').max(150),
        phone: zod_1.z.string().trim().max(30).regex(/^[+\d][\d\s()-]*$/, 'Enter a valid phone number').optional().or(zod_1.z.literal('')),
        email: zod_1.z.string().trim().email('Enter a valid organization email').max(150).optional().or(zod_1.z.literal('')),
        address: zod_1.z.string().trim().max(300).optional(),
        website: zod_1.z.string().trim().max(200).regex(/^https?:\/\/[^\s]+$/i, 'Website must start with http:// or https://').optional().or(zod_1.z.literal(''))
    }).strict().optional()
}).strict();
exports.createUserSchema = zod_1.z.object({
    fullName: zod_1.z.string().min(2, 'Full name must be at least 2 characters'),
    email: zod_1.z.string().email('Invalid email address'),
    // Omit to have a password generated and emailed to the new account
    password: zod_1.z.string().min(6, 'Password must be at least 6 characters').optional(),
    phone: zod_1.z.string().optional(),
    role: zod_1.z.enum([User_1.Role.ADMIN, User_1.Role.ORGANIZER, User_1.Role.SYSTEM_USER]),
    // Admin only: the organizer a new staff account is added for
    organizerId: zod_1.z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
    profile: zod_1.z.object({
        organizationName: zod_1.z.string().max(150).optional(),
        logoKey: zod_1.z.string().max(200).optional()
    }).strict().optional()
}).strict();
exports.updateUserSchema = zod_1.z.object({
    fullName: zod_1.z.string().min(2, 'Full name must be at least 2 characters').optional(),
    email: zod_1.z.string().email('Invalid email address').optional(),
    phone: zod_1.z.string().optional(),
    password: zod_1.z.string().min(6, 'Password must be at least 6 characters').optional(),
    isActive: zod_1.z.boolean().optional(),
    profile: zod_1.z.object({
        organizationName: zod_1.z.string().max(150).optional(),
        logoKey: zod_1.z.string().max(200).optional()
    }).strict().optional()
}).strict();
exports.changePasswordSchema = zod_1.z.object({
    currentPassword: zod_1.z.string().min(1, 'Current password is required'),
    newPassword: zod_1.z.string().min(8, 'New password must be at least 8 characters')
}).strict();
