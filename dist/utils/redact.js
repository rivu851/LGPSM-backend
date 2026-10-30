"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactTokens = void 0;
// Tokens travel in URL paths (the invitation link: /api/v1/public/invitations/<token>[/rsvp|/card]). A request log or a security log
// that wrote the path verbatim would store a live secret. Anything that looks like one of our tokens (64 hex characters, which is
// also the shape of a stored hash) is replaced before a path is logged.
const TOKEN_IN_PATH = /[a-f0-9]{64}/gi;
const redactTokens = (text) => text.replace(TOKEN_IN_PATH, ':token');
exports.redactTokens = redactTokens;
