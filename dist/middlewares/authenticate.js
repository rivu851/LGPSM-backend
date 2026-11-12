"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticate = void 0;
const token_1 = require("../utils/token");
const User_1 = require("../models/User");
const securityLog_1 = require("../utils/securityLog");
const userAuthCache_1 = require("../utils/userAuthCache");
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
        // Verify user still exists and is active. Only the two fields needed are read, and the answer is kept for a few seconds
        // (cleared at once whenever an account is written), so a burst of requests costs one database read, not one each.
        let account = userAuthCache_1.userAuthCache.get(payload.userId);
        if (!account) {
            const user = await User_1.User.findById(payload.userId).select('role isActive').lean();
            if (!user) {
                res.status(401).json({ success: false, message: 'User no longer exists.' });
                return;
            }
            account = { role: user.role, isActive: user.isActive };
            userAuthCache_1.userAuthCache.set(payload.userId, account);
        }
        if (!account.isActive) {
            (0, securityLog_1.securityEvent)('AUTH_INACTIVE_USER', req, { subject: String(payload.userId) });
            res.status(403).json({ success: false, code: 'ACCOUNT_INACTIVE', message: 'User account is inactive.' });
            return;
        }
        // The role is read from the database, not the token, so demotions apply immediately instead of
        // surviving until the access token expires.
        req.user = { ...payload, role: account.role };
        next();
    }
    catch (error) {
        next(error);
    }
};
exports.authenticate = authenticate;
