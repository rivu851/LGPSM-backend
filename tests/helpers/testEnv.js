// Loaded by jest before any test module (see jest.config.js). The test suite must never see real credentials or reach a real
// service: src/config/env.ts skips the developer's .env under NODE_ENV=test, and every provider credential is blanked here even if
// the calling shell exported one. Tests that exercise a provider set their own fake values and stub the network.
process.env.NODE_ENV = 'test';

const REQUIRED_PLACEHOLDERS = {
  ATLAS_URL: 'mongodb://127.0.0.1:27017/lgpsm-test-placeholder-never-connected',
  FRONTEND_URL: 'http://localhost:3000',
  JWT_SECRET: 'test-only-access-secret-not-real-0000000000',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-real-000000000',
};
Object.assign(process.env, REQUIRED_PLACEHOLDERS);

for (const key of [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'BREVO_API_KEY', 'BREVO_SENDER',
  'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_CANCELLATION_TEMPLATE', 'WHATSAPP_REPLACEMENT_TEMPLATE', 'WHATSAPP_REVOCATION_TEMPLATE',
  'STITCH_API_KEY', 'AWS_S3_BUCKET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_CLOUDFRONT_DOMAIN',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'QR_TOKEN_SECRET',
]) {
  delete process.env[key];
}
