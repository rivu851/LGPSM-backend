import express from 'express';
import request from 'supertest';
import { redactTokens } from '../src/utils/redact';
import { requestLogger } from '../src/middlewares/requestLogger';
import { securityEvent } from '../src/utils/securityLog';
import { generateSecureToken, hashToken } from '../src/utils/invitation.util';

describe('tokens never reach a log line', () => {
  it('redacts 64-hex tokens and hashes from a path, and nothing else', () => {
    const t = generateSecureToken();
    expect(redactTokens(`/api/v1/public/invitations/${t}/rsvp`)).toBe('/api/v1/public/invitations/:token/rsvp');
    expect(redactTokens(`/x/${hashToken(t)}`)).toBe('/x/:token');
    expect(redactTokens('/api/v1/events/6ae4cb6c0af0cc8af5adb60c/invitees')).toBe('/api/v1/events/6ae4cb6c0af0cc8af5adb60c/invitees');
  });

  it('the request log shows the route, status and time, but not the token in the path or any query value', async () => {
    const lines: string[] = [];
    const app = express();
    app.use(requestLogger({ write: (l) => { lines.push(l); } }));
    app.get('/api/v1/public/invitations/:token', (_req, res) => res.json({ ok: true }));
    const t = generateSecureToken();
    await request(app).get(`/api/v1/public/invitations/${t}?utm=${generateSecureToken()}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^GET \/api\/v1\/public\/invitations\/:token 200 /);
    expect(lines.join('')).not.toMatch(/[a-f0-9]{64}/);
  });

  it('the security log redacts a token in the path as well', () => {
    const out: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    process.env.SECURITY_LOG_IN_TEST = 'true';
    const t = generateSecureToken();
    securityEvent('AUTH_FORBIDDEN' as any, { ip: '127.0.0.1', method: 'GET', originalUrl: `/api/v1/public/invitations/${t}/card?x=1`, user: undefined } as any);
    delete process.env.SECURITY_LOG_IN_TEST;
    spy.mockRestore();
    expect(out.join('')).toContain('/api/v1/public/invitations/:token/card');
    expect(out.join('')).not.toMatch(/[a-f0-9]{64}/);
  });
});
