"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticate = void 0;
const token_1 = require("../utils/token");
const User_1 = require("../models/User");
const securityLog_1 = require("../utils/securityLog");
const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ success: false, message: 'Authentication required. Missing Bearer token.' });
            return;
        }
        const token = authHeader.split(' ')[1];
        let payload;
        try {
            payload = (0, token_1.verifyAccessToken)(token);
        }
        catch (err) {
            (0, securityLog_1.securityEvent)('AUTH_TOKEN_REJECTED', req, { reason: err?.name || 'invalid' });
            res.status(401).json({ success: false, message: 'Invalid or expired token.' });
            return;
        }
        // Verify user still exists and is active
        const user = await User_1.User.findById(payload.userId);
        if (!user) {
            res.status(401).json({ success: false, message: 'User no longer exists.' });
            return;
        }
        if (!user.isActive) {
            (0, securityLog_1.securityEvent)('AUTH_INACTIVE_USER', req, { subject: String(user._id) });
            res.status(403).json({ success: false, message: 'User account is inactive.' });
            return;
        }
        // The role is read from the database, not the token, so demotions apply immediately instead of
        // surviving until the access token expires.
        req.user = { ...payload, role: user.role };
        next();
    }
    catch (error) {
        next(error);
    }
};
exports.authenticate = authenticate;
