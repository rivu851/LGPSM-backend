"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.idempotent = void 0;
const crypto_1 = __importDefault(require("crypto"));
const IdempotencyKey_1 = require("../models/IdempotencyKey");
/** A request that has been "in progress" this long is taken to have died with its process, and may be run again. */
const STALE_PENDING_MS = 2 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
/**
 * Optional protection against the same create request being carried out twice. A client that sends `Idempotency-Key: <random id>`
 * gets exactly one result for that key (per user and operation): a repeat returns the first response (marked `Idempotent-Replay`),
 * a repeat that arrives while the first is still running is answered 409, and a repeat with a different body is refused. A request
 * that failed leaves no trace, so it can be sent again with the same key. Clients that send no key behave exactly as before.
 */
const idempotent = (scope) => async (req, res, next) => {
    try {
        const raw = req.header('Idempotency-Key');
        if (!raw)
            return next();
        if (!KEY_PATTERN.test(raw)) {
            res.status(400).json({ success: false, error: 'Bad Request', code: 'IDEMPOTENCY_KEY_INVALID', message: 'Idempotency-Key must be 8 to 128 letters, digits or - _ . :' });
            return;
        }
        const userId = req.user?.userId;
        if (!userId)
            return next();
        const requestHash = crypto_1.default.createHash('sha256').update(JSON.stringify(req.body ?? {})).digest('hex');
        const id = { userId, scope, key: raw };
        let claimed = false;
        try {
            await IdempotencyKey_1.IdempotencyKey.create({ ...id, requestHash, state: 'PENDING' });
            claimed = true;
        }
        catch (e) {
            if (e?.code !== 11000)
                throw e;
        }
        if (!claimed) {
            const existing = await IdempotencyKey_1.IdempotencyKey.findOne(id).lean();
            if (existing) {
                if (existing.requestHash !== requestHash) {
                    res.status(422).json({ success: false, error: 'Unprocessable Entity', code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used for a different request.' });
                    return;
                }
                if (existing.state === 'DONE') {
                    res.setHeader('Idempotent-Replay', 'true');
                    res.status(existing.status || 200).json(existing.body);
                    return;
                }
                // still running elsewhere, unless it is so old that its process must have died
                const takeover = await IdempotencyKey_1.IdempotencyKey.findOneAndUpdate({ ...id, state: 'PENDING', createdAt: { $lt: new Date(Date.now() - STALE_PENDING_MS) } }, { $set: { createdAt: new Date(), requestHash } });
                if (!takeover) {
                    res.status(409).json({ success: false, error: 'Conflict', code: 'REQUEST_IN_PROGRESS', message: 'This request is already being processed. Please wait a moment.' });
                    return;
                }
            }
            // (a record that vanished between the two reads simply means the first attempt failed: carry on and run this one)
        }
        // Record the outcome before it is sent: a success is kept for replays, anything else is forgotten so the user can try again
        const send = res.json.bind(res);
        let settled = false;
        res.json = ((body) => {
            if (settled)
                return send(body);
            settled = true;
            const ok = res.statusCode >= 200 && res.statusCode < 300;
            const done = ok
                ? IdempotencyKey_1.IdempotencyKey.updateOne(id, { $set: { state: 'DONE', status: res.statusCode, body } })
                : IdempotencyKey_1.IdempotencyKey.deleteOne(id);
            done.catch((err) => console.error('Idempotency record not saved:', err?.message)).finally(() => send(body));
            return res;
        });
        next();
    }
    catch (error) {
        next(error);
    }
};
exports.idempotent = idempotent;
