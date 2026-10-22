"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const zod_1 = require("zod");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const envSchema = zod_1.z.object({
    PORT: zod_1.z.string().default('5000'),
    NODE_ENV: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    ATLAS_URL: zod_1.z.string().min(1, 'ATLAS_URL is required'),
    DNS_SERVER: zod_1.z.string().optional().default('8.8.8.8'),
    FRONTEND_URL: zod_1.z.string().default('http://localhost:3000'),
    // Time zone used when dates are rendered on the server (invitation cards, emails, WhatsApp)
    APP_TIMEZONE: zod_1.z.string().default('Asia/Kolkata'),
    JWT_SECRET: zod_1.z.string().min(1, 'JWT_SECRET is required'),
    JWT_REFRESH_SECRET: zod_1.z.string().min(1, 'JWT_REFRESH_SECRET is required'),
    JWT_EXPIRES_IN: zod_1.z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: zod_1.z.string().default('7d'),
    GOOGLE_CLIENT_ID: zod_1.z.string().optional(),
    AWS_REGION: zod_1.z.string().default('us-east-1'),
    AWS_S3_BUCKET: zod_1.z.string().optional(),
    AWS_ACCESS_KEY_ID: zod_1.z.string().optional(),
    AWS_SECRET_ACCESS_KEY: zod_1.z.string().optional(),
    AWS_CLOUDFRONT_DOMAIN: zod_1.z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: zod_1.z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: zod_1.z.string().default('1397912796731568'),
    WHATSAPP_BUSINESS_ACCOUNT_ID: zod_1.z.string().default('1366427858610266'),
    WHATSAPP_API_VERSION: zod_1.z.string().default('v25.0'),
    WHATSAPP_INVITATION_TEMPLATE: zod_1.z.string().default('lgpsm_event_invitation'),
    WHATSAPP_TEMPLATE_LANGUAGE: zod_1.z.string().default('en_US'),
    // Google Stitch (AI template generation). Server-side only; generation reports "unavailable" when the key is absent.
    STITCH_API_KEY: zod_1.z.string().optional(),
    STITCH_TIMEOUT_MS: zod_1.z.coerce.number().int().min(5000).max(300000).default(120000),
    STITCH_DAILY_QUOTA_PER_USER: zod_1.z.coerce.number().int().min(1).max(500).default(15),
    STITCH_MAX_CONCURRENT_JOBS: zod_1.z.coerce.number().int().min(1).max(10).default(2),
});
const _env = envSchema.safeParse(process.env);
if (!_env.success) {
    console.error('❌ Invalid environment variables:', _env.error.format());
    process.exit(1);
}
exports.env = _env.data;
// Advisory only (never blocks start-up, never prints values): weak or shared signing secrets make
// every issued token easier to forge, and a leaked access secret would also expose refresh tokens.
if (exports.env.NODE_ENV === 'production') {
    if (exports.env.JWT_SECRET.length < 32 || exports.env.JWT_REFRESH_SECRET.length < 32) {
        console.warn('[security] JWT_SECRET / JWT_REFRESH_SECRET are shorter than 32 characters. Rotate them to long random values.');
    }
    if (exports.env.JWT_SECRET === exports.env.JWT_REFRESH_SECRET) {
        console.warn('[security] JWT_SECRET and JWT_REFRESH_SECRET are identical. Use two different random secrets.');
    }
}
