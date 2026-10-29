import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('5000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ATLAS_URL: z.string().min(1, 'ATLAS_URL is required'),
  DNS_SERVER: z.string().optional().default('8.8.8.8'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  // Extra browser origins allowed by CORS (comma-separated), e.g. beta or preview deployments
  CORS_ORIGINS: z.string().optional(),
  // Time zone used when dates are rendered on the server (invitation cards, emails, WhatsApp)
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_S3_BUCKET: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_CLOUDFRONT_DOMAIN: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().default('1397912796731568'),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().default('1366427858610266'),
  WHATSAPP_API_VERSION: z.string().default('v25.0'),
  WHATSAPP_INVITATION_TEMPLATE: z.string().default('lgpsm_event_invitation'),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('en_US'),
  // Google Stitch (AI template generation). Server-side only; generation reports "unavailable" when the key is absent.
  STITCH_API_KEY: z.string().optional(),
  STITCH_TIMEOUT_MS: z.coerce.number().int().min(5000).max(300000).default(120000),
  STITCH_DAILY_QUOTA_PER_USER: z.coerce.number().int().min(1).max(500).default(15),
  STITCH_MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(10).default(2),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;

// Advisory only (never blocks start-up, never prints values): weak or shared signing secrets make
// every issued token easier to forge, and a leaked access secret would also expose refresh tokens.
if (env.NODE_ENV === 'production') {
  if (env.JWT_SECRET.length < 32 || env.JWT_REFRESH_SECRET.length < 32) {
    console.warn('[security] JWT_SECRET / JWT_REFRESH_SECRET are shorter than 32 characters. Rotate them to long random values.');
  }
  if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    console.warn('[security] JWT_SECRET and JWT_REFRESH_SECRET are identical. Use two different random secrets.');
  }
}
