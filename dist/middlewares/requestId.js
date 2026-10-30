"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestId = requestId;
const crypto_1 = __importDefault(require("crypto"));
// Correlates a request with its audit entries. A caller-supplied id is only kept when it is a short safe token.
function requestId(req, res, next) {
    const incoming = req.header('x-request-id');
    const id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : crypto_1.default.randomUUID();
    req.requestId = id;
    res.setHeader('x-request-id', id);
    next();
}
