"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizeRoles = void 0;
const securityLog_1 = require("../utils/securityLog");
const authorizeRoles = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ success: false, message: 'Authentication required.' });
            return;
        }
        if (!roles.includes(req.user.role)) {
            (0, securityLog_1.securityEvent)('AUTHZ_DENIED', req, { required: roles.join(',') });
            res.status(403).json({ success: false, message: 'Forbidden. Insufficient permissions.' });
            return;
        }
        next();
    };
};
exports.authorizeRoles = authorizeRoles;
