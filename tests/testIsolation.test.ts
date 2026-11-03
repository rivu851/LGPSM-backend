import fs from 'fs';
import path from 'path';
import { env } from '../src/config/env';

// The suite must be safe to run on a developer's machine with a real .env present.
describe('test isolation', () => {
  it('runs under NODE_ENV=test with placeholder secrets and a loopback database address', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(env.ATLAS_URL).toMatch(/^mongodb:\/\/127\.0\.0\.1/);
    expect(env.JWT_SECRET).toMatch(/^test-only-/);
    expect(env.JWT_REFRESH_SECRET).toMatch(/^test-only-/);
  });

  it('no provider credential is present, whatever the developer .env holds', () => {
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'BREVO_API_KEY', 'WHATSAPP_ACCESS_TOKEN', 'STITCH_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET']) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  it('the config does not load .env under test', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/config/env.ts'), 'utf8');
    expect(source).toMatch(/process\.env\.NODE_ENV !== 'test'\) dotenv\.config\(\)/);
  });
});
