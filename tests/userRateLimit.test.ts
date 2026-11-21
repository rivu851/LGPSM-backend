// Per-person limits, the guard against the same request twice, and the limiters' counters living in the key-value store.
import express from 'express';
import request from 'supertest';
import { perUserLimit, dedupeWindow } from '../src/middlewares/userRateLimit';
import { loginAccountLimiter } from '../src/middlewares/rateLimiter';
import { kv } from '../src/infra/kv';

beforeAll(() => { process.env.ENABLE_RATE_LIMIT_TESTS = 'true'; });
afterAll(() => { delete process.env.ENABLE_RATE_LIMIT_TESTS; });

const as = (userId: string) => (req: any, _res: any, next: any) => { req.user = { userId, role: 'ORGANIZER' }; next(); };

describe('per-person limit', () => {
  it('counts each person separately and answers 429 with how long to wait', async () => {
    const app = express();
    app.get('/a/:u', (req, _res, next) => as(String(req.params.u))(req, _res, next), perUserLimit('t-limit', { windowMs: 5_000, max: 3 }), (_req, res) => res.json({ ok: true }));
    for (let i = 0; i < 3; i++) expect((await request(app).get('/a/alice')).status).toBe(200);
    const fourth = await request(app).get('/a/alice');
    expect(fourth.status).toBe(429);
    expect(fourth.body).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(fourth.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(fourth.headers['ratelimit-remaining']).toBe('0');
    // someone else is unaffected
    expect((await request(app).get('/a/bob')).status).toBe(200);
  });

  it('lets people back in when the window ends (the counter expires by itself)', async () => {
    const app = express();
    app.get('/b', as('carol'), perUserLimit('t-expire', { windowMs: 700, max: 1 }), (_req, res) => res.json({ ok: true }));
    expect((await request(app).get('/b')).status).toBe(200);
    expect((await request(app).get('/b')).status).toBe(429);
    await new Promise((r) => setTimeout(r, 800));
    expect((await request(app).get('/b')).status).toBe(200);
  });
});

describe('the same request twice', () => {
  it('refuses an identical request inside the window, allows a different one, and forgets a failed one', async () => {
    const app = express();
    app.use(express.json());
    let fail = false;
    app.post('/pay', as('dave'), dedupeWindow('t-dedupe', 1_500), (_req, res) => res.status(fail ? 400 : 201).json({ ok: !fail }));
    const body = { eventId: 'e1' };
    expect((await request(app).post('/pay').send(body)).status).toBe(201);
    const again = await request(app).post('/pay').send(body);
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('DUPLICATE_REQUEST');
    expect((await request(app).post('/pay').send({ eventId: 'e2' })).status).toBe(201); // a different request
    // a request that failed does not block the corrected retry
    fail = true;
    expect((await request(app).post('/pay').send({ eventId: 'e3' })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 50));
    fail = false;
    expect((await request(app).post('/pay').send({ eventId: 'e3' })).status).toBe(201);
    // and after the window the first request is allowed again
    await new Promise((r) => setTimeout(r, 1_600));
    expect((await request(app).post('/pay').send(body)).status).toBe(201);
  });
});

describe('the existing limiters keep their counters in the key-value store', () => {
  it('a sign-in limiter counts failures there and stops the 11th', async () => {
    const app = express();
    app.use(express.json());
    app.post('/login', loginAccountLimiter, (_req, res) => res.status(401).json({ ok: false }));
    for (let i = 0; i < 10; i++) expect((await request(app).post('/login').send({ email: 'x@y.com' })).status).toBe(401);
    expect((await request(app).post('/login').send({ email: 'x@y.com' })).status).toBe(429);
    expect(kv.kind).toBe('memory');
    const counted = [await kv.get('rl:loginAccountLimiter:x@y.com|127.0.0.1'), await kv.get('rl:loginAccountLimiter:x@y.com|::ffff:127.0.0.1')];
    expect(counted.some((v) => v !== null && Number(v) >= 10)).toBe(true);
  });
});
