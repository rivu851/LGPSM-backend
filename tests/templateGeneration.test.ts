// MOCKED PROVIDER: Stitch is replaced by a deterministic fake that returns the recorded concept in tests/fixtures.
// Everything else (routes, auth, validation, jobs, MongoDB, converter, renderer, invitation workflow) is the real code.
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../src/app';
import { env } from '../src/config/env';
import { User, Role } from '../src/models/User';
import { Template } from '../src/models/Template';
import { Event } from '../src/models/Event';
import { Media } from '../src/models/Media';
import { Invitee } from '../src/models/Invitee';
import { Invitation, DeliveryChannel } from '../src/models/Invitation';
import { TemplateGenerationJob } from '../src/models/TemplateGenerationJob';
import { generateAccessToken } from '../src/utils/token';
import { setStitchProvider, StitchProvider, StitchProviderError, StitchScreenArtifacts } from '../src/services/stitch/stitch.provider';
import { drain, failExpiredJobs, buildStitchPrompt, recoverOnStartup } from '../src/services/stitch/templateGeneration.service';
import { loadCardContext } from '../src/services/cardTemplates/context';
import { invitationService } from '../src/services/invitation.service';
import { invitationUrlFor } from '../src/utils/qrPayload';
import { decodeQr } from './helpers/qr';

jest.mock('../src/utils/email.provider', () => ({ sendEmail: jest.fn().mockResolvedValue(true) }));
import { sendEmail } from '../src/utils/email.provider';

jest.setTimeout(180000);

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', n));
let mongoServer: MongoMemoryServer;
let admin: any, orgA: any, orgB: any, staff: any;
const bearer = (u: any) => `Bearer ${generateAccessToken(String(u._id), u.role)}`;
const api = (m: 'get' | 'post' | 'patch' | 'delete', url: string, who?: any) => {
  const r = (request(app) as any)[m](url);
  return who ? r.set('Authorization', bearer(who)) : r;
};
const binary = (r: any) => r.buffer(true).parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

// ---- the fake provider ----
let calls: Array<{ op: string; input: any }> = [];
let behaviour: 'ok' | 'html-garbage' | { fail: StitchProviderError } | 'hang' = 'ok';
let release: (() => void) | null = null;
let n = 0;
const art = (html?: string): StitchScreenArtifacts => ({ projectId: 'proj-1', screenId: `screen-${++n}`, html: html ?? fixture('stitch-gala.html').toString('utf8'), screenshot: fixture('stitch-gala.png') });
const fake: StitchProvider = {
  isConfigured: () => true,
  async generate(input) {
    calls.push({ op: 'generate', input });
    return run(() => [art(behaviour === 'html-garbage' ? '<html><body><p>nothing usable</p></body></html>' : undefined)]).then((a) => a[0]);
  },
  async edit(input) {
    calls.push({ op: 'edit', input });
    return run(() => [art()]).then((a) => a[0]);
  },
  async variants(input) {
    calls.push({ op: 'variants', input });
    return run(() => Array.from({ length: input.options.count }, () => art()));
  }
};
async function run(make: () => StitchScreenArtifacts[]) {
  if (typeof behaviour === 'object') throw behaviour.fail;
  if (behaviour === 'hang') await new Promise<void>((resolve) => (release = resolve));
  return make();
}

const brief = { kind: 'INVITATION', preset: 'INVITATION_PORTRAIT', prompt: 'Elegant black and gold awards gala invitation', style: { mood: 'elegant' } };
const waitFor = async (id: string, who: any, until = ['SUCCEEDED', 'CONCEPT_ONLY', 'FAILED']) => {
  await drain();
  const res = await api('get', `/api/v1/template-generations/${id}`, who);
  expect(until).toContain(res.body.data.status);
  return res.body.data;
};
async function generated(who = orgA, body: any = brief) {
  const res = await api('post', '/api/v1/template-generations', who).send(body);
  expect([200, 202]).toContain(res.status);
  return waitFor(res.body.data.id, who);
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await TemplateGenerationJob.syncIndexes();
  await Template.syncIndexes();
  admin = await User.create({ fullName: 'Root', email: 'root.gen@example.com', role: Role.ADMIN, isActive: true, isEmailVerified: true });
  orgA = await User.create({ fullName: 'Org A', email: 'a.gen@example.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
  orgB = await User.create({ fullName: 'Org B', email: 'b.gen@example.com', role: Role.ORGANIZER, isActive: true, isEmailVerified: true });
  staff = await User.create({ fullName: 'Staff', email: 's.gen@example.com', role: Role.SYSTEM_USER, isActive: true, isEmailVerified: true });
  setStitchProvider(fake);
});
afterAll(async () => {
  setStitchProvider(null);
  await mongoose.disconnect();
  await mongoServer.stop();
});
beforeEach(async () => {
  await drain(); // let anything the previous test left running finish before the counters reset
  calls = [];
  behaviour = 'ok';
  release = null;
  (env as any).STITCH_DAILY_QUOTA_PER_USER = 50;
  await TemplateGenerationJob.deleteMany({});
});

describe('generation API: access control', () => {
  it('requires a signed-in organizer or admin', async () => {
    expect((await api('post', '/api/v1/template-generations').send(brief)).status).toBe(401);
    expect((await api('get', '/api/v1/template-generations', staff)).status).toBe(403);
    expect((await api('post', '/api/v1/template-generations', staff).send(brief)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("hides an organizer's generations from every other organizer, but not from an admin", async () => {
    const job = await generated(orgA);
    for (const url of [`/api/v1/template-generations/${job.id}`]) {
      expect((await api('get', url, orgB)).status).toBe(404);
      expect((await api('get', url, admin)).status).toBe(200);
    }
    expect((await api('delete', `/api/v1/template-generations/${job.id}`, orgB)).status).toBe(404);
    expect((await api('post', `/api/v1/template-generations/${job.id}/variants/0/edit`, orgB).send({ prompt: 'make it blue please' })).status).toBe(404);
    expect((await api('post', `/api/v1/template-generations/${job.id}/variants/0/save`, orgB).send({ name: 'Stolen' })).status).toBe(404);
    expect((await api('get', '/api/v1/template-generations', orgB)).body.data).toHaveLength(0);
    expect((await api('get', '/api/v1/template-generations', orgA)).body.data).toHaveLength(1);
    expect(await Template.countDocuments({ name: 'Stolen' })).toBe(0);
  });

  it('never returns provider references or the stored specification', async () => {
    const job = await generated();
    const raw = JSON.stringify(job);
    expect(raw).not.toMatch(/proj-1|screen-\d|designSpec|projectId|screenId/);
  });
});

describe('generation API: requests', () => {
  it('validates prompt, size and style', async () => {
    const bad = (body: any) => api('post', '/api/v1/template-generations', orgA).send({ ...brief, ...body });
    expect((await bad({ prompt: 'short' })).status).toBe(400);
    expect((await bad({ prompt: 'x'.repeat(801) })).status).toBe(400);
    expect((await bad({ kind: 'BILLBOARD' })).status).toBe(400);
    expect((await bad({ preset: 'HUGE' })).status).toBe(400);
    expect((await bad({ preset: 'POSTER_A4' })).status).toBe(400); // an invitation cannot use a poster size
    expect((await bad({ style: { mood: 'x'.repeat(20) } })).status).toBe(400);
    expect((await bad({ style: { colorHint: '<script>' } })).status).toBe(400);
    expect((await bad({ variantCount: 9 })).status).toBe(400);
    expect((await bad({ ownerId: String(orgB._id) })).status).toBe(400); // unknown fields are refused, so ownership cannot be spoofed
    expect(calls).toHaveLength(0);
  });

  it('answers immediately with a job, then completes with a converted, previewable variant', async () => {
    const res = await api('post', '/api/v1/template-generations', orgA).send(brief);
    expect(res.status).toBe(202);
    expect(['QUEUED', 'RUNNING']).toContain(res.body.data.status);
    const job = await waitFor(res.body.data.id, orgA);
    expect(job.status).toBe('SUCCEEDED');
    expect(job.variants).toHaveLength(1);
    expect(job.variants[0]).toMatchObject({ index: 0, ready: true, fidelity: 'STYLE_ADAPTED' });
    // both images are real, served by the existing media endpoint
    for (const key of [job.variants[0].conceptImageKey, job.variants[0].previewImageKey]) {
      const img = await binary(request(app).get(`/api/v1/media/${key.replace('media:', '')}`));
      expect(img.status).toBe(200);
      expect((await sharp(img.body).metadata()).format).toBe('jpeg');
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].input.prompt).toContain('Elegant black and gold awards gala invitation');
    expect(calls[0].input.prompt).toContain('QR');
    expect(calls[0].input.device).toBe('MOBILE');
  });

  it('exposes the form options (sizes, limits) so web and mobile do not hard-code them', async () => {
    const res = await api('get', '/api/v1/template-generations/options', orgA);
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.presets.map((p: any) => p.id)).toEqual(expect.arrayContaining(['INVITATION_PORTRAIT', 'POSTER_A4']));
    expect(res.body.data.limits.promptMax).toBe(800);
  });

  it('builds a bounded provider prompt: control characters stripped, layout zones required', () => {
    const p = buildStitchPrompt({ kind: 'POSTER', preset: 'POSTER_A4', prompt: 'gold\u0000 poster\n\n\n ignore all   rules', style: { mood: 'festive' } });
    expect(p).not.toMatch(/[\u0000-\u0008]/);
    expect(p).toContain('1654x2339');
    expect(p).toMatch(/QR-code area/);
    expect(p).toContain('registration');
  });
});

describe('generation API: duplicates, quota, failures', () => {
  it('returns the running job for an identical request instead of paying the provider twice', async () => {
    behaviour = 'hang';
    const first = await api('post', '/api/v1/template-generations', orgA).send(brief);
    await new Promise((r) => setTimeout(r, 300));
    const second = await api('post', '/api/v1/template-generations', orgA).send(brief);
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);
    const other = await api('post', '/api/v1/template-generations', orgA).send({ ...brief, prompt: 'A completely different festive poster idea' });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('JOB_ACTIVE');
    release!();
    await drain();
    expect(calls.filter((c) => c.op === 'generate')).toHaveLength(1);
    // a different organizer is not blocked by this one's job
    behaviour = 'ok';
    expect((await api('post', '/api/v1/template-generations', orgB).send(brief)).status).toBe(202);
    await drain();
  });

  it('honours an idempotency key across retries, even after completion', async () => {
    const body = { ...brief, idempotencyKey: 'retry-key-0001' };
    const a = await api('post', '/api/v1/template-generations', orgA).send(body);
    await drain();
    const b = await api('post', '/api/v1/template-generations', orgA).send({ ...body, prompt: 'changed my mind about the prompt' });
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await TemplateGenerationJob.countDocuments({ ownerId: orgA._id })).toBe(1);
    // two simultaneous retries still create one job
    const [c, d] = await Promise.all([1, 2].map(() => api('post', '/api/v1/template-generations', orgB).send({ ...brief, idempotencyKey: 'race-key-00001' })));
    expect(c.body.data.id).toBe(d.body.data.id);
    await drain();
  });

  it('enforces the daily quota per organizer and says when to retry', async () => {
    (env as any).STITCH_DAILY_QUOTA_PER_USER = 2;
    await generated(orgA, { ...brief, prompt: 'first festive invitation idea here' });
    await generated(orgA, { ...brief, prompt: 'second festive invitation idea here' });
    const blocked = await api('post', '/api/v1/template-generations', orgA).send({ ...brief, prompt: 'third festive invitation idea here' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('QUOTA_EXCEEDED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
    expect((await api('post', '/api/v1/template-generations', orgB).send(brief)).status).toBe(202); // another organizer's allowance is separate
    await drain();
  });

  it('reports the real daily usage, updates it after each generation, and never counts failures that never reached the provider', async () => {
    (env as any).STITCH_DAILY_QUOTA_PER_USER = 3;
    const fresh = (await api('get', '/api/v1/template-generations/options', orgA)).body.data.usage;
    expect(fresh).toMatchObject({ used: 0, limit: 3, remaining: 3 });
    const first = await api('post', '/api/v1/template-generations', orgA).send({ ...brief, prompt: 'usage counter idea number one' });
    expect(first.body.usage).toMatchObject({ used: 1, limit: 3, remaining: 2 });
    await drain();
    await api('post', '/api/v1/template-generations', orgA).send({ ...brief, prompt: 'usage counter idea number two', variantCount: 3 });
    await drain();
    expect((await api('get', '/api/v1/template-generations/options', orgA)).body.data.usage).toMatchObject({ used: 2, remaining: 1 }); // one request = one use, however many options
    // the other organizer's count is separate; an admin has no limit
    expect((await api('get', '/api/v1/template-generations/options', orgB)).body.data.usage).toMatchObject({ used: 0, remaining: 3 });
    expect((await api('get', '/api/v1/template-generations/options', admin)).body.data.usage).toMatchObject({ limit: null, remaining: null });
    // a request refused before it started does not use the allowance
    (await api('post', '/api/v1/template-generations', orgA).send({ ...brief, prompt: 'x' })).status;
    expect((await api('get', '/api/v1/template-generations/options', orgA)).body.data.usage.used).toBe(2);
  });

  it.each([
    ['PROVIDER_AUTH', new StitchProviderError('AUTH', 'rejected')],
    ['PROVIDER_QUOTA', new StitchProviderError('QUOTA', 'quota')],
    ['PROVIDER_TIMEOUT', new StitchProviderError('TIMEOUT', 'slow')],
    ['PROVIDER_NETWORK', new StitchProviderError('NETWORK', 'down')],
    ['BAD_PROVIDER_RESPONSE', new StitchProviderError('MALFORMED', 'bad')],
    ['PROVIDER_FAILED', new StitchProviderError('PROVIDER', 'failed')]
  ])('reports a genuine %s failure, never a fake success, and leaves nothing behind', async (code, error) => {
    behaviour = { fail: error };
    const mediaBefore = await Media.countDocuments({});
    const job = await generated();
    expect(job.status).toBe('FAILED');
    expect(job.error.code).toBe(code);
    expect(job.variants).toHaveLength(0);
    expect(job.error.message).not.toMatch(/rejected|stitch|key/i);
    expect(await Template.countDocuments({ source: { $exists: true, $ne: null }, 'source.provider': 'STITCH' })).toBe(0);
    expect(await Media.countDocuments({})).toBe(mediaBefore);
    // a failed job does not block the next attempt
    behaviour = 'ok';
    expect((await generated()).status).toBe('SUCCEEDED');
  });

  it('reports "unavailable" up front when the provider is not configured, without creating a job', async () => {
    setStitchProvider({ ...fake, isConfigured: () => false });
    const res = await api('post', '/api/v1/template-generations', orgA).send(brief);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PROVIDER_UNAVAILABLE');
    expect(await TemplateGenerationJob.countDocuments({})).toBe(0);
    expect((await api('get', '/api/v1/template-generations/options', orgA)).body.data.available).toBe(false);
    setStitchProvider(fake);
  });

  it('fails a job whose run was interrupted instead of leaving it running forever', async () => {
    const stuck = await TemplateGenerationJob.create({ ownerId: orgA._id, kind: 'INVITATION', preset: 'INVITATION_PORTRAIT', prompt: 'a stuck generation request', promptHash: 'x', status: 'RUNNING', startedAt: new Date(Date.now() - 3600_000), leaseExpiresAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 1e9) });
    const waiting = await TemplateGenerationJob.create({ ownerId: orgB._id, kind: 'INVITATION', preset: 'INVITATION_PORTRAIT', prompt: 'a forgotten queued request', promptHash: 'y', status: 'QUEUED', expiresAt: new Date(Date.now() + 1e9) });
    await TemplateGenerationJob.collection.updateOne({ _id: waiting._id }, { $set: { createdAt: new Date(Date.now() - 3600_000) } }); // createdAt is immutable through the model
    expect(await failExpiredJobs()).toBe(2);
    const res = await api('get', `/api/v1/template-generations/${stuck._id}`, orgA);
    expect(res.body.data).toMatchObject({ status: 'FAILED', error: { code: 'INTERRUPTED' } });
    expect((await TemplateGenerationJob.findById(waiting._id))!.error!.code).toBe('EXPIRED');
    // and a restart fails whatever was in flight, then the owner can generate again
    await TemplateGenerationJob.updateOne({ _id: stuck._id }, { $set: { status: 'RUNNING', leaseExpiresAt: new Date(Date.now() + 1e6) }, $unset: { error: 1 } });
    await recoverOnStartup();
    expect((await TemplateGenerationJob.findById(stuck._id))!.status).toBe('FAILED');
    expect((await generated(orgA)).status).toBe('SUCCEEDED');
  });
});

describe('malformed or unusable provider output', () => {
  it('keeps the concept for viewing but marks it not ready, and refuses to save it as a template', async () => {
    behaviour = 'html-garbage';
    const job = await generated();
    expect(job.status).toBe('CONCEPT_ONLY');
    expect(job.variants[0]).toMatchObject({ ready: false, fidelity: 'NONE' });
    expect(job.variants[0].conceptImageKey).toMatch(/^media:/);
    expect(job.variants[0].previewImageKey).toBeUndefined();
    expect(job.variants[0].notes.length).toBeGreaterThan(0);
    const save = await api('post', `/api/v1/template-generations/${job.id}/variants/0/save`, orgA).send({ name: 'Should not save' });
    expect(save.status).toBe(409);
    expect(save.body.code).toBe('NOT_CONVERTIBLE');
    expect(await Template.countDocuments({ name: 'Should not save' })).toBe(0);
  });

  it('fails the job when the screenshot is not an image, and stores no media for it', async () => {
    const original = fake.generate;
    (fake as any).generate = async () => ({ ...art(), screenshot: Buffer.from('<svg onload=alert(1)>') });
    try {
      const before = await Media.countDocuments({});
      const job = await generated();
      expect(job.status).toBe('FAILED');
      expect(job.error.code).toBe('BAD_PROVIDER_RESPONSE');
      expect(await Media.countDocuments({})).toBe(before);
    } finally {
      (fake as any).generate = original;
    }
  });
});

describe('several options in one request', () => {
  it('returns as many distinct designs as were asked for: the first generation plus real variations', async () => {
    const job = await generated(orgA, { ...brief, variantCount: 3 });
    expect(job.status).toBe('SUCCEEDED');
    expect(job.variants).toHaveLength(3);
    expect(new Set(job.variants.map((v: any) => v.conceptImageKey)).size).toBe(3);
    expect(calls.map((c) => c.op)).toEqual(['generate', 'variants']);
    expect(calls[1].input.options.count).toBe(2);
    expect(calls[1].input.screenId).toMatch(/^screen-/);
  });

  it('keeps the first design and reports fewer than requested when the extra options fail', async () => {
    const original = fake.variants;
    (fake as any).variants = async () => { throw new StitchProviderError('QUOTA', 'busy'); };
    try {
      const job = await generated(orgA, { ...brief, variantCount: 2 });
      expect(job.status).toBe('SUCCEEDED');
      expect(job.variants).toHaveLength(1);
      expect(job.variantCount).toBe(2); // what was asked for, so clients can say "1 of 2"
    } finally {
      (fake as any).variants = original;
    }
  });

  it('makes a single call for a single option', async () => {
    await generated(orgA, { ...brief, variantCount: 1 });
    expect(calls.map((c) => c.op)).toEqual(['generate']);
  });
});

describe('edit and variations', () => {
  it('edits a design through the provider and produces a new previewable result', async () => {
    const first = await generated();
    const res = await api('post', `/api/v1/template-generations/${first.id}/variants/0/edit`, orgA).send({ prompt: 'make the heading larger and add more gold' });
    expect(res.status).toBe(202);
    const edited = await waitFor(res.body.data.id, orgA);
    expect(edited).toMatchObject({ status: 'SUCCEEDED', mode: 'EDIT', parentJobId: first.id });
    expect(calls.map((c) => c.op)).toEqual(['generate', 'edit']);
    expect(calls[1].input).toMatchObject({ projectId: 'proj-1', prompt: 'make the heading larger and add more gold' });
  });

  it('creates bounded variations of a design', async () => {
    const first = await generated();
    const res = await api('post', `/api/v1/template-generations/${first.id}/variants/0/variations`, orgA).send({ prompt: 'explore other colour schemes', variantCount: 3 });
    const job = await waitFor(res.body.data.id, orgA);
    expect(job.variants).toHaveLength(3);
    expect(calls[1].input.options.count).toBe(3);
    expect((await api('post', `/api/v1/template-generations/${first.id}/variants/0/variations`, orgA).send({ prompt: 'too many please', variantCount: 4 })).status).toBe(400);
    expect((await api('post', `/api/v1/template-generations/${first.id}/variants/7/edit`, orgA).send({ prompt: 'bad variant number' })).status).toBe(400);
    expect((await api('post', `/api/v1/template-generations/${first.id}/variants/2/edit`, orgA).send({ prompt: 'variant that does not exist' })).status).toBe(404);
  });
});

describe('saving, using, editing and deleting a template', () => {
  let template: any;

  it('saves a converted design as a private draft owned by the organizer, idempotently', async () => {
    const job = await generated(orgA);
    const [a, b] = await Promise.all([1, 2].map(() => api('post', `/api/v1/template-generations/${job.id}/variants/0/save`, orgA).send({ name: 'Gala Gold' })));
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.data._id).toBe(b.body.data._id);
    template = a.body.data;
    expect(template).toMatchObject({ name: 'Gala Gold', cardDesign: 'CUSTOM', kind: 'INVITATION', isPublished: false, isSystemTemplate: false });
    expect(String(template.ownerId)).toBe(String(orgA._id));
    expect(template.designSpec.version).toBe(1);
    expect(await Template.countDocuments({ name: 'Gala Gold' })).toBe(1);
    // the master template carries no event details and no QR code
    const raw = JSON.stringify(template.designSpec);
    for (const leaked of ['Annual Leadership Summit', 'Guest Name', 'data:image', 'http']) expect(raw).not.toContain(leaked);
  });

  it('shows it only to its owner and admins', async () => {
    const id = template._id;
    expect((await api('get', `/api/v1/templates/${id}`, orgA)).status).toBe(200);
    expect((await api('get', `/api/v1/templates/${id}`, admin)).status).toBe(200);
    expect((await api('get', `/api/v1/templates/${id}`, orgB)).status).toBe(404);
    const ids = async (who: any, q = '') => (await api('get', `/api/v1/templates${q}`, who)).body.data.map((t: any) => t._id);
    expect(await ids(orgB)).not.toContain(id);
    expect(await ids(orgA, '?scope=mine')).toContain(id);
    expect(await ids(orgA)).not.toContain(id); // a draft is not offered in the event form until it is published
    expect(await ids(orgB, '?scope=mine')).not.toContain(id);
    expect(await ids(admin)).toContain(id);
    expect(await ids(orgA, '?scope=mine&kind=POSTER')).not.toContain(id);
  });

  it('lets the owner rename and publish it, but not alter ownership, engine or visibility to others', async () => {
    const id = template._id;
    expect((await api('patch', `/api/v1/templates/${id}`, orgB).send({ name: 'Hijack' })).status).toBe(404);
    expect((await api('patch', `/api/v1/templates/${id}`, orgA).send({ ownerId: String(orgB._id) })).status).toBe(400);
    expect((await api('patch', `/api/v1/templates/${id}`, orgA).send({ isSystemTemplate: true })).status).toBe(400);
    expect((await api('patch', `/api/v1/templates/${id}`, orgA).send({ cardDesign: 'WEDDING' })).status).toBe(400);
    expect((await api('patch', `/api/v1/templates/${id}`, orgA).send({ designSpec: { version: 1, elements: [{ type: 'html' }] } })).status).toBe(400);
    const ok = await api('patch', `/api/v1/templates/${id}`, orgA).send({ name: 'Gala Gold v2', isPublished: true });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ name: 'Gala Gold v2', isPublished: true, isSystemTemplate: false });
    // published means "available for the owner's events", not "visible to everyone"
    expect((await api('get', `/api/v1/templates`, orgA)).body.data.map((t: any) => t._id)).toContain(id);
    expect((await api('get', `/api/v1/templates`, orgB)).body.data.map((t: any) => t._id)).not.toContain(id);
    expect((await api('get', `/api/v1/templates/${id}`, orgB)).status).toBe(404);
    // the designers' templates stay admin-only
    const system = await Template.create({ name: 'Designers', cardDesign: 'WEDDING', isPublished: true });
    expect((await api('patch', `/api/v1/templates/${system._id}`, orgA).send({ name: 'x1' })).status).toBe(403);
    expect((await api('delete', `/api/v1/templates/${system._id}`, orgA)).status).toBe(403);
  });

  it('draws a preview for the owner only, from the stored design', async () => {
    const id = template._id;
    const form = { title: 'Moloy Wedding Reception', startIso: '2026-11-07T18:00:00+05:30', venue: '24 Shanti Pally', guestName: 'Mr. Harsh' };
    const own = await binary(api('post', `/api/v1/templates/${id}/preview`, orgA).send(form));
    expect(own.status).toBe(200);
    expect(own.headers['x-invitation-qr']).toBe('SAMPLE');
    expect((await sharp(own.body).metadata()).width).toBe(1080);
    expect((await api('post', `/api/v1/templates/${id}/preview`, orgB).send(form)).status).toBe(404);
    const unauth = await api('post', `/api/v1/templates/${id}/preview`).send(form);
    expect(unauth.status).toBe(401);
  });

  it("will not let another organizer's event use it, and falls back safely if one somehow does", async () => {
    const eventBody = (templateId: any) => ({ title: 'B Event', description: 'desc', format: 'PHYSICAL', location: { type: 'Point', address: '1 Road', coordinates: [0, 0] }, schedule: { start: new Date(Date.now() + 86400000), end: new Date(Date.now() + 90000000) }, templateId });
    const res = await api('post', '/api/v1/events', orgB).send(eventBody(template._id));
    expect(res.status).toBe(201);
    expect((await Event.findById(res.body.data.eventId))!.templateId).toBeUndefined();
    const ok = await api('post', '/api/v1/events', orgA).send(eventBody(template._id));
    expect(ok.status).toBe(201);
    expect(String((await Event.findById(ok.body.data.eventId))!.templateId)).toBe(String(template._id));
    const upd = await api('patch', `/api/v1/events/${res.body.data.eventId}`, orgB).send({ templateId: String(template._id) });
    expect(upd.status).toBe(400); // the event API reports an unusable template as a bad request
    expect((await Event.findById(res.body.data.eventId))!.templateId).toBeUndefined();
    // direct DB assignment (a bug or old data): rendering ignores a design the event's organizer may not use
    const rogue = await Event.create({ organizerId: orgB._id, title: 'Rogue', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', location: { type: 'Point', address: 'x', coordinates: [0, 0] } as any, schedule: { start: new Date(), end: new Date() }, templateId: template._id });
    const ctx = await loadCardContext(rogue);
    expect(ctx.designSpec).toBeUndefined();
    expect(ctx.cardDesign).not.toBe('CUSTOM');
  });

  it('can be deleted by its owner only, and then disappears everywhere', async () => {
    const tmp = await Template.create({ name: 'Disposable', cardDesign: 'CUSTOM', kind: 'INVITATION', designSpec: template.designSpec, ownerId: orgA._id, isSystemTemplate: false, isPublished: true });
    expect((await api('delete', `/api/v1/templates/${tmp._id}`, orgB)).status).toBe(404);
    expect((await api('delete', `/api/v1/templates/${tmp._id}`, orgA)).status).toBe(200);
    expect((await api('get', `/api/v1/templates/${tmp._id}`, orgA)).status).toBe(404);
    expect((await api('get', '/api/v1/templates?scope=mine', orgA)).body.data.map((t: any) => t._id)).not.toContain(String(tmp._id));
    expect((await api('delete', `/api/v1/templates/${tmp._id}`, orgA)).status).toBe(404);
  });

  it('lets an admin publish a design for every organizer', async () => {
    const adminJob = await generated(admin);
    const saved = await api('post', `/api/v1/template-generations/${adminJob.id}/variants/0/save`, admin).send({ name: 'House Style', publish: true });
    expect(saved.status).toBe(201);
    expect(saved.body.data).toMatchObject({ isSystemTemplate: true, isPublished: true });
    expect((await api('get', '/api/v1/templates', orgB)).body.data.map((t: any) => t._id)).toContain(saved.body.data._id);
    expect((await api('post', `/api/v1/templates/${saved.body.data._id}/preview`, orgB).send({})).status).toBe(200);
  });

  it('deleting a generation removes its images but keeps a saved template\'s preview', async () => {
    const j = await generated(orgA, { ...brief, prompt: 'a design that will be saved then deleted' });
    const saved = (await api('post', `/api/v1/template-generations/${j.id}/variants/0/save`, orgA).send({ name: 'Kept' })).body.data;
    expect((await api('delete', `/api/v1/template-generations/${j.id}`, orgB)).status).toBe(404);
    expect((await api('delete', `/api/v1/template-generations/${j.id}`, orgA)).status).toBe(200);
    expect(await Media.exists({ _id: j.variants[0].conceptImageKey.replace('media:', '') })).toBeNull();
    expect(await Media.exists({ _id: saved.previewImageKey.replace('media:', '') })).not.toBeNull();
    expect((await api('get', `/api/v1/templates/${saved._id}`, orgA)).status).toBe(200);
  });
});

describe('real events: rendering, QR codes and exports', () => {
  let template: any, event: any;
  beforeAll(async () => {
    const j = await generated(orgA, { ...brief, prompt: 'rendering test invitation in gold' });
    template = (await api('post', `/api/v1/template-generations/${j.id}/variants/0/save`, orgA).send({ name: 'Render Gold', publish: true })).body.data;
    event = await Event.create({ organizerId: orgA._id, title: 'Roy & Dola Wedding Reception', description: 'An evening of celebration with family', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', location: { type: 'Point', address: '24 Shanti Pally, Kolkata', coordinates: [0, 0] } as any, schedule: { start: new Date('2026-11-07T12:30:00Z'), end: new Date('2026-11-07T16:30:00Z') }, templateId: template._id });
  });

  it('draws the template with the real event at full size, as PNG and JPEG', async () => {
    const png = await binary(api('post', `/api/v1/templates/${template._id}/render`, orgA).send({ eventId: String(event._id) }));
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['x-invitation-qr']).toBe('SAMPLE'); // an invitation's real QR is per guest, issued by the invitation workflow
    expect(await sharp(png.body).metadata()).toMatchObject({ width: 1080, height: 1920, format: 'png' });
    const jpg = await binary(api('post', `/api/v1/templates/${template._id}/render`, orgA).send({ eventId: String(event._id), format: 'jpeg' }));
    expect(jpg.headers['content-type']).toBe('image/jpeg');
    expect(await sharp(jpg.body).metadata()).toMatchObject({ width: 1080, height: 1920, format: 'jpeg' });
    expect((await decodeQr(jpg.body))).toContain('/invitation/preview-sample'); // still scannable after JPEG compression
  });

  it('refuses someone else\'s event or template', async () => {
    const body = { eventId: String(event._id) };
    expect((await api('post', `/api/v1/templates/${template._id}/render`, orgB).send(body)).status).toBe(404); // not B's template
    const bEvent = await Event.create({ organizerId: orgB._id, title: 'B', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', location: { type: 'Point', address: 'x', coordinates: [0, 0] } as any, schedule: { start: new Date(), end: new Date() } });
    expect((await api('post', `/api/v1/templates/${template._id}/render`, orgA).send({ eventId: String(bEvent._id) })).status).toBe(404); // not A's event
    expect((await api('post', `/api/v1/templates/${template._id}/render`, orgA).send({ eventId: 'nope' })).status).toBe(400);
    expect((await api('post', `/api/v1/templates/${template._id}/render`).send(body)).status).toBe(401);
    expect((await api('post', `/api/v1/templates/${template._id}/render`, staff).send(body)).status).toBe(403);
  });

  it('puts the registration QR on a poster, scannable, and leaves it out (saying so) when no link is given', async () => {
    const j = await generated(orgA, { kind: 'POSTER', preset: 'POSTER_A4', prompt: 'a gold poster for a charity wedding gala' });
    const poster = (await api('post', `/api/v1/template-generations/${j.id}/variants/0/save`, orgA).send({ name: 'Poster Gold' })).body.data;
    expect(poster.kind).toBe('POSTER');
    const link = 'https://lgpsm-frontend.vercel.app/r/abc123';
    const withQr = await binary(api('post', `/api/v1/templates/${poster._id}/render`, orgA).send({ eventId: String(event._id), registrationUrl: link }));
    expect(withQr.headers['x-invitation-qr']).toBe('LINK');
    expect(await sharp(withQr.body).metadata()).toMatchObject({ width: 1654, height: 2339 });
    expect(await decodeQr(withQr.body)).toBe(link);
    const without = await binary(api('post', `/api/v1/templates/${poster._id}/render`, orgA).send({ eventId: String(event._id) }));
    expect(without.headers['x-invitation-qr']).toBe('NONE');
    expect(without.headers['x-render-warnings']).toMatch(/QR/);
    expect(await decodeQr(without.body)).toBeNull();
    expect((await api('post', `/api/v1/templates/${poster._id}/render`, orgA).send({ eventId: String(event._id), registrationUrl: 'http://insecure.example' })).status).toBe(400);
    expect((await api('post', `/api/v1/templates/${poster._id}/render`, orgA).send({ eventId: String(event._id), registrationUrl: 'javascript:alert(1)' })).status).toBe(400);
    const list = (await api('get', '/api/v1/templates?scope=mine&kind=POSTER', orgA)).body.data.map((t: any) => t._id);
    expect(list).toContain(poster._id);
    expect(list).not.toContain(template._id);
  });

  it('is used by the real invitation workflow: each attendee gets their own scannable QR on the saved design', async () => {
    const invitees = await Invitee.create([
      { eventId: event._id, name: 'Asha Verma', email: 'asha@example.com', mobile: '+919876500001', company: 'Acme' },
      { eventId: event._id, name: 'Bipin Roy', email: 'bipin@example.com', mobile: '+919876500002' }
    ]);
    (sendEmail as jest.Mock).mockClear();
    const results = await invitationService.sendInvitations(String(event._id), String(orgA._id), invitees.map((i) => String(i._id)), DeliveryChannel.EMAIL);
    expect(results.map((r: any) => r.status)).toEqual(['SENT', 'SENT']);
    expect(await Invitation.countDocuments({ eventId: event._id })).toBe(2);

    const mails = (sendEmail as jest.Mock).mock.calls;
    expect(mails).toHaveLength(2);
    const decoded: string[] = [];
    const byGuest: Record<string, string> = {};
    for (const [to, , , attachments] of mails) {
      const card: Buffer = attachments.find((a: any) => a.filename === 'invitation-card.png').content;
      const meta = await sharp(card).metadata();
      expect([meta.width, meta.height]).toEqual([1080, 1920]); // the custom design, not a Figma card (786 x 1364) or the classic one (1536 x 2048)
      const url = await decodeQr(card);
      expect(url).toMatch(/\/invitation\/[a-f0-9]{64}$/);
      decoded.push(url!);
      byGuest[to] = url!;
      expect(to).toMatch(/@example\.com/);
    }
    expect(decoded[0]).not.toBe(decoded[1]);
    // each decoded QR is that guest's real, check-in-valid invitation link (its hash is what was stored)
    const crypto = await import('crypto');
    const stored = (await Invitee.find({ eventId: event._id })).map((i) => i.qrTokenHash).sort();
    expect(decoded.map((u) => crypto.createHash('sha256').update(u.split('/').pop()!).digest('hex')).sort()).toEqual(stored);

    // the organizer's preview of an invited guest is the same design with that guest's current code
    const preview = await invitationService.previewInvitationCard(String(event._id), String(orgA._id), String(invitees[0]._id));
    expect(preview.qr).toBe('ISSUED');
    expect((await sharp(preview.png).metadata()).width).toBe(1080);
    expect(await decodeQr(preview.png)).toBe(invitationUrlFor(byGuest['asha@example.com'].split('/').pop()!));
  });

  it('keeps the existing workflow untouched for events without a custom template', async () => {
    const plain = await Event.create({ organizerId: orgA._id, title: 'Birthday Bash', description: 'd', categoryId: new mongoose.Types.ObjectId(), format: 'PHYSICAL', location: { type: 'Point', address: 'x', coordinates: [0, 0] } as any, schedule: { start: new Date(), end: new Date() } });
    const ctx = await loadCardContext(plain);
    expect(ctx.designSpec).toBeUndefined();
    expect(ctx.cardDesign).toBe('BIRTHDAY');
    const png = (await invitationService.previewInvitationCard(String(plain._id), String(orgA._id))).png;
    expect((await sharp(png).metadata()).width).toBe(786);
  });
});
