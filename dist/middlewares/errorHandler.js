"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = exports.isDatabaseOutage = void 0;
exports.notFoundHandler = notFoundHandler;
const env_1 = require("../config/env");
function notFoundHandler(req, res) {
    res.status(404).json({ success: false, message: 'Route not found' });
}
const DATABASE_OUTAGE_ERRORS = new Set(['MongoServerSelectionError', 'MongooseServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoNotConnectedError', 'MongoTopologyClosedError', 'MongoWaitQueueTimeoutError']);
const isDatabaseOutage = (err) => DATABASE_OUTAGE_ERRORS.has(String(err.name)) || /buffering timed out/.test(String(err.message));
exports.isDatabaseOutage = isDatabaseOutage;
function resolveStatus(err) {
    // Nothing was done and the request is safe to repeat: say so, instead of a generic server error
    if ((0, exports.isDatabaseOutage)(err)) {
        return { statusCode: 503, message: 'The service is temporarily unavailable. Please try again in a moment.', code: 'SERVICE_UNAVAILABLE' };
    }
    if (err.name === 'CastError') {
        return { statusCode: 400, message: `Invalid ${err.path || 'identifier'} format` };
    }
    if (err.name === 'ValidationError') {
        return { statusCode: 400, message: err.message || 'Validation failed' };
    }
    if (err.name === 'ZodError') {
        const issues = err.issues
            ?.map((issue) => `${issue.path?.join('.') || 'input'}: ${issue.message || 'Invalid value'}`)
            .join('; ');
        return { statusCode: 400, message: issues ? `Validation failed: ${issues}` : 'Validation failed' };
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' || err.message === 'Invalid token type') {
        return { statusCode: 401, message: 'Invalid or expired token' };
    }
    if (err.code === 11000) {
        const keys = Object.keys(err.keyPattern || err.keyValue || {});
        if (keys.includes('mobileKey'))
            return { statusCode: 409, message: 'A guest with this mobile number is already on this event\'s active list.', code: 'DUPLICATE_INVITEE' };
        if (keys.includes('email') && keys.includes('eventId'))
            return { statusCode: 409, message: 'A guest with this email address is already on this event\'s active list.', code: 'DUPLICATE_INVITEE' };
        return { statusCode: 409, message: 'A record with the same unique value already exists' };
    }
    if (err.type === 'entity.parse.failed') {
        return { statusCode: 400, message: 'Malformed JSON request body' };
    }
    if (err.type === 'entity.too.large') {
        return { statusCode: 413, message: 'Request body is too large' };
    }
    if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
        return { statusCode: 415, message: 'Unsupported request encoding' };
    }
    if (err.name === 'MulterError') {
        return err.code === 'LIMIT_FILE_SIZE'
            ? { statusCode: 413, message: 'Uploaded file is too large' }
            : { statusCode: 400, message: err.message || 'Invalid file upload' };
    }
    const status = [err.statusCode, err.status].find((value) => typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599);
    if (status !== undefined) {
        return {
            statusCode: status,
            message: status < 500 || err.exposeMessage ? err.message || 'Request failed' : 'Internal Server Error',
            ...(typeof err.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code) ? { code: err.code } : {}),
        };
    }
    return { statusCode: 500, message: 'Internal Server Error' };
}
const errorHandler = (err, req, res, next) => {
    if (res.headersSent) {
        next(err);
        return;
    }
    const error = err && typeof err === 'object' ? err : {};
    const { statusCode, message, code } = resolveStatus(error);
    if (statusCode >= 500) {
        console.error('Error:', error.message || err);
    }
    res.status(statusCode).json({
        success: false,
        ...(code ? { code } : {}),
        message,
        ...(env_1.env.NODE_ENV === 'development' && statusCode >= 500 && { stack: error.stack }),
    });
};
exports.errorHandler = errorHandler;
