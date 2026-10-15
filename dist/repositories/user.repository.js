"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRepository = void 0;
const User_1 = require("../models/User");
const whatsapp_service_1 = require("../services/whatsapp.service");
exports.userRepository = {
    async findByEmail(email) {
        return User_1.User.findOne({ email });
    },
    /**
     * Looks up accounts by normalized phone number via the indexed `phone` field
     * (no collection scan). Returns up to 2 matches so the caller can detect and
     * safely reject an ambiguous match (phone isn't a unique field) rather than
     * silently picking one account.
     */
    async findByPhone(rawPhone) {
        const normalized = (0, whatsapp_service_1.normalizePhoneNumber)(rawPhone);
        if (!normalized)
            return [];
        return User_1.User.find({ phone: normalized }).limit(2);
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
    /**
     * Updates a user matched by email address.
     * Used by the email-verification flow (updateByEmail happens before the
     * user has a session, so we can't rely on an ID).
     */
    async updateByEmail(email, updateData) {
        return User_1.User.findOneAndUpdate({ email }, updateData, { new: true, runValidators: true });
    },
    /**
     * Hard-deletes a user by email.  Called by the registration rollback path
     * when SMTP delivery fails, ensuring no orphaned inactive accounts remain.
     */
    async deleteByEmail(email) {
        await User_1.User.deleteOne({ email });
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
