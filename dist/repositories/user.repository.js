"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRepository = void 0;
const User_1 = require("../models/User");
const whatsapp_service_1 = require("../services/whatsapp.service");
exports.userRepository = {
    async findByEmail(email) {
        return User_1.User.findOne({ email });
    },
    async findAllByEmail(email) {
        return User_1.User.find({ email });
    },
    async findByRoleAndEmail(email, role) {
        return User_1.User.findOne({ email, role });
    },
    /**
     * Looks up all accounts by normalized phone number via the indexed `phone`
     * field. Login resolves shared numbers using the password and requested role.
     */
    async findByPhone(rawPhone) {
        const normalized = (0, whatsapp_service_1.normalizePhoneNumber)(rawPhone);
        if (!normalized)
            return [];
        return User_1.User.find({ phone: normalized });
    },
    async findById(id) {
        return User_1.User.findById(id);
    },
    async create(data) {
        const user = new User_1.User(data);
        return user.save();
    },
    async updateById(id, updateData) {
        return User_1.User.findByIdAndUpdate(id, updateData, { new: true, runValidators: true });
    },
    async verifyOrganizerEmail(email) {
        await User_1.User.updateMany({ email, role: User_1.Role.ORGANIZER }, { $set: { isEmailVerified: true } });
    },
    async deleteById(id) {
        await User_1.User.deleteOne({ _id: id });
    },
    async find(query = {}) {
        return User_1.User.find(query).select('-passwordHash').sort({ createdAt: -1 });
    },
    async findPage(query, skip, limit) {
        return User_1.User.find(query)
            .select('-passwordHash')
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .lean();
    },
    async count(query = {}) {
        return User_1.User.countDocuments(query);
    },
};
