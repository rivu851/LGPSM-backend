"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dns_1 = __importDefault(require("dns"));
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
async function startServer() {
    try {
        await (0, database_1.default)();
        // generation jobs a restart interrupted are failed (not left "running"), and queued ones resume
        await (0, templateGeneration_service_1.recoverOnStartup)().catch((e) => console.error('Template generation recovery failed:', e?.message));
        // cancellation notices that were still waiting when the process stopped are sent now (they are stored, not held in memory)
        passNotice_service_1.passNoticeService.resumeAll().catch((e) => console.error('Pass notice resume failed:', e?.message));
        cancellationNotice_service_1.cancellationNoticeService.resumeAll().catch((e) => console.error('Cancellation notice resume failed:', e?.message));
        app_1.default.listen(env_1.env.PORT, () => {
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
