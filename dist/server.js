"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dns_1 = __importDefault(require("dns"));
const mongoose_1 = __importDefault(require("mongoose"));
const app_1 = __importDefault(require("./app"));
const database_1 = __importDefault(require("./config/database"));
const env_1 = require("./config/env");
const passNotice_service_1 = require("./services/passNotice.service");
const cancellationNotice_service_1 = require("./services/cancellationNotice.service");
const templateGeneration_service_1 = require("./services/stitch/templateGeneration.service");
// Render containers have no outbound IPv6 route. Node's default DNS ordering can still return an
// IPv6 address first for dual-stack hosts (smtp.gmail.com, some third-party APIs), which then
// fails with ENETUNREACH. Prefer IPv4 results process-wide so every outbound connection benefits,
// not just SMTP.
dns_1.default.setDefaultResultOrder('ipv4first');
const NOTICE_SWEEP_MS = 60 * 1000;
const SHUTDOWN_GRACE_MS = 25 * 1000;
let server;
let noticeTimer;
let sweeping = false;
function sweepNotices() {
    if (sweeping)
        return;
    sweeping = true;
    Promise.allSettled([passNotice_service_1.passNoticeService.resumeAll(), cancellationNotice_service_1.cancellationNoticeService.resumeAll()])
        .then((results) => results.forEach((r) => { if (r.status === 'rejected')
        console.error('Notice sweep failed:', r.reason?.message); }))
        .finally(() => { sweeping = false; });
}
// The host sends SIGTERM on every deploy: stop taking new requests and let the ones in flight (a check-in, a send) finish.
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    console.log(`${signal} received: finishing requests in flight`);
    if (noticeTimer)
        clearInterval(noticeTimer);
    const force = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
    force.unref();
    const closeDatabase = () => mongoose_1.default.disconnect().catch(() => undefined).finally(() => process.exit(0));
    if (server)
        server.close(closeDatabase);
    else
        closeDatabase();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// One forgotten rejection in background work must not take down every event's check-in. It is logged; request-scoped errors have their own handler.
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason?.message || reason));
async function startServer() {
    try {
        await (0, database_1.default)();
        // generation jobs a restart interrupted are failed (not left "running"), and queued ones resume
        await (0, templateGeneration_service_1.recoverOnStartup)().catch((e) => console.error('Template generation recovery failed:', e?.message));
        // cancellation notices that were still waiting when the process stopped are sent now (they are stored, not held in memory)
        await cancellationNotice_service_1.cancellationNoticeService.enqueueMissingAfterRestart().catch((e) => console.error('Cancellation notice recovery failed:', e?.message));
        sweepNotices();
        // A dispatch cut short (provider or database outage, a crash on another instance) is picked up without waiting for a restart. Each
        // channel is claimed atomically, so several instances sweeping at once cannot send a message twice.
        noticeTimer = setInterval(sweepNotices, NOTICE_SWEEP_MS);
        noticeTimer.unref();
        server = app_1.default.listen(env_1.env.PORT, () => {
            console.log(`Server is running on port ${env_1.env.PORT}`);
            console.log(`Environment: ${env_1.env.NODE_ENV}`);
        });
    }
    catch (error) {
        console.error(`MongoDB connection failed: ${error.message}`);
        process.exit(1);
    }
}
startServer();
