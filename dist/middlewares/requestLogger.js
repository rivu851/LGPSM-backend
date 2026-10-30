"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = void 0;
const morgan_1 = __importDefault(require("morgan"));
const redact_1 = require("../utils/redact");
// Per-request log line (method, path, status, time) with tokens removed from the path. The query string is not logged.
morgan_1.default.token('safe-url', (req) => (0, redact_1.redactTokens)(String(req.originalUrl || req.url || '').split('?')[0]));
const requestLogger = (stream) => (0, morgan_1.default)(':method :safe-url :status :response-time ms', stream ? { stream } : undefined);
exports.requestLogger = requestLogger;
