import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('5000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  ATLAS_URL: z.string().min(1, 'ATLAS_URL is required'),
  DNS_SERVER: z.string().optional().default('8.8.8.8'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  // Time zone used when dates are rendered on the server (invitation cards, emails, WhatsApp)
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  GOOGLE_CLIENT_ID: z.string().optional(),
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
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Invalid environment variables:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;
