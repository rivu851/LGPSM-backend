"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userRepository = void 0;
const User_1 = require("../models/User");
exports.userRepository = {
    async findByEmail(email) {
        return User_1.User.findOne({ email });
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
};
