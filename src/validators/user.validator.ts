import { z } from 'zod';

import { Role } from '../models/User';

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name must be at least 2 characters').max(120, 'Full name is too long').optional(),
  phone: z.string().optional(),
  // Keys become part of a database update path, so only plain names are accepted
  profile: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'Invalid profile field'), z.any()).optional(),
  // The organizer's organization, kept apart from their personal details (name, phone). Organizers and admins only.
  organization: z.object({
    name: z.string().trim().min(1, 'Organization name is required').max(150),
    phone: z.string().trim().max(30).regex(/^[+\d][\d\s()-]*$/, 'Enter a valid phone number').optional().or(z.literal('')),
    email: z.string().trim().email('Enter a valid organization email').max(150).optional().or(z.literal('')),
    address: z.string().trim().max(300).optional(),
    website: z.string().trim().max(200).regex(/^https?:\/\/[^\s]+$/i, 'Website must start with http:// or https://').optional().or(z.literal(''))
  }).strict().optional()
}).strict();

export const createUserSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name must be at least 2 characters').max(120, 'Full name is too long'),
  email: z.string().email('Invalid email address'),
  // Omit to have a password generated and emailed to the new account
  password: z.string().min(8, 'Password must be at least 8 characters').optional(),
  phone: z.string().optional(),
  role: z.enum([Role.ADMIN, Role.ORGANIZER, Role.SYSTEM_USER]),
  // Admin only: the organizer a new staff account is added for
  organizerId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  profile: z.object({
    organizationName: z.string().max(150).optional(),
    logoKey: z.string().max(200).optional()
  }).strict().optional()
}).strict();

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(2, 'Full name must be at least 2 characters').max(120, 'Full name is too long').optional(),
  email: z.string().email('Invalid email address').optional(),
  phone: z.string().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters').optional(),
  isActive: z.boolean().optional(),
  profile: z.object({
    organizationName: z.string().max(150).optional(),
    logoKey: z.string().max(200).optional()
  }).strict().optional()
}).strict();

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters')
}).strict();
