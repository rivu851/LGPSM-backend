import crypto from 'crypto';
import mongoose from 'mongoose';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { env } from '../../config/env';
import { Media, MediaPurpose } from '../../models/Media';
import { Template, ITemplate } from '../../models/Template';
import { Category } from '../../models/Category';
import { TemplateGenerationJob, ITemplateGenerationJob, IJobVariant, JobMode } from '../../models/TemplateGenerationJob';
import { Role } from '../../models/User';
import { CANVAS_PRESETS, CanvasPresetId, DesignSpec, safeParseDesignSpec } from '../cardTemplates/designSpec';
import { renderDesignSpec } from '../cardTemplates/specRenderer';
import { convertStitchDesign } from './stitch.converter';
import { SAMPLE_TEXTS } from './sampleData';
import { getStitchProvider, StitchDevice, StitchErrorKind, StitchProviderError, StitchScreenArtifacts } from './stitch.provider';

// Runs AI template generation as persistent jobs (MongoDB). The provider call takes tens of seconds, so the API
// answers immediately with a job that the web and mobile apps poll. No queue infrastructure is needed: jobs are
// claimed atomically in this process, bounded by STITCH_MAX_CONCURRENT_JOBS, and anything interrupted is failed
// by `failExpiredJobs`, so nothing can stay "running" forever. Concurrency is per server process, which matches the
// single API instance this runs on; if the API is ever scaled out, the atomic claim keeps jobs from running twice.

export type GenerationErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTH'
  | 'QUOTA_EXCEEDED'
  | 'PROVIDER_QUOTA'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_NETWORK'
  | 'PROVIDER_FAILED'
  | 'BAD_PROVIDER_RESPONSE'
  | 'JOB_ACTIVE'
  | 'JOB_NOT_FOUND'
  | 'VARIANT_NOT_FOUND'
  | 'NOT_CONVERTIBLE'
  | 'INTERRUPTED'
  | 'EXPIRED'
  | 'INVALID_REQUEST';

export class GenerationError extends Error {
  constructor(public readonly code: GenerationErrorCode, public readonly status: number, message: string, public readonly retryAfterSeconds?: number) {
    super(message);
  }
}

const JOB_TTL_MS = 7 * 24 * 3600 * 1000;
const QUEUE_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const CONCEPT_EDGE = 900;
const MEDIA_PREFIX = 'ai-template:';

const PROVIDER_MESSAGES: Record<StitchErrorKind, { code: GenerationErrorCode; message: string }> = {
  NOT_CONFIGURED: { code: 'PROVIDER_UNAVAILABLE', message: 'AI template generation is not available right now.' },
  AUTH: { code: 'PROVIDER_AUTH', message: 'AI template generation is temporarily unavailable. Our team has been notified.' },
  QUOTA: { code: 'PROVIDER_QUOTA', message: 'The design service is busy right now. Please try again in a while.' },
  NETWORK: { code: 'PROVIDER_NETWORK', message: 'The design service could not be reached. Please try again.' },
  TIMEOUT: { code: 'PROVIDER_TIMEOUT', message: 'The design service took too long. Please try again.' },
  MALFORMED: { code: 'BAD_PROVIDER_RESPONSE', message: 'The design service returned something we could not use. Please try again.' },
  PROVIDER: { code: 'PROVIDER_FAILED', message: 'The design service could not create this design. Try rephrasing your request.' }
};

export interface Actor {
  userId: string;
  role: string;
}
const isAdmin = (a: Actor) => a.role === Role.ADMIN || a.role === 'ADMIN';
const ownerFilter = (a: Actor) => (isAdmin(a) ? {} : { ownerId: new mongoose.Types.ObjectId(a.userId) });

export interface CreateJobInput {
  kind: 'INVITATION' | 'POSTER';
  preset: CanvasPresetId;
  prompt: string;
  style?: { mood?: string; colorHint?: string };
  variantCount?: number;
  idempotencyKey?: string;
}

// ---------- prompt ----------

// eslint-disable-next-line no-control-regex
export const cleanPrompt = (t: string) => t.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();

export function deviceFor(preset: CanvasPresetId): StitchDevice {
  const { width, height } = CANVAS_PRESETS[preset];
  const aspect = width / height;
  return aspect > 1.3 ? 'DESKTOP' : aspect >= 0.8 ? 'TABLET' : 'MOBILE';
}

export function buildStitchPrompt(input: { kind: 'INVITATION' | 'POSTER'; preset: CanvasPresetId; prompt: string; style?: { mood?: string; colorHint?: string } }): string {
  const { width, height } = CANVAS_PRESETS[input.preset];
  const what = input.kind === 'INVITATION' ? 'a personal event invitation card' : 'an event poster';
  const zones =
    input.kind === 'INVITATION'
      ? 'event title, a short description, date and time, venue, the organizer name or logo, the invited guest\'s name, and a large square QR-code area with a white background for entrance check-in'
      : 'event title, a short description, date and time, venue, the organizer name or logo, and a large square QR-code area with a white background for registration';
  const style = [input.style?.mood ? `mood: ${input.style.mood}` : '', input.style?.colorHint ? `colours: ${input.style.colorHint}` : ''].filter(Boolean).join('; ');
  return [
    `Design ${what} template as ONE static graphic of ${width}x${height} pixels (aspect ${(width / height).toFixed(2)}). It is a printable/shareable graphic, not an app screen: no navigation bars, buttons, menus or scrolling.`,
    `Clear zones for: ${zones}. Use only generic placeholder wording and no real people, brands or phone numbers.`,
    style ? `Style preferences - ${style}.` : '',
    `Creative brief from the organizer: ${cleanPrompt(input.prompt)}`
  ]
    .filter(Boolean)
    .join('\n');
}

const hashOf = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

// ---------- job lifecycle ----------

const inflight = new Set<Promise<void>>();
let running = 0;
let lastSweep = 0;

/** Fails jobs that can no longer finish: a run whose lease ran out (the process died or hung) and a job that waited too long. */
export async function failExpiredJobs(now = new Date()): Promise<number> {
  const stuck = await TemplateGenerationJob.updateMany(
    { status: 'RUNNING', leaseExpiresAt: { $lt: now } },
    { $set: { status: 'FAILED', finishedAt: now, error: { code: 'INTERRUPTED', message: 'This generation did not finish. Please try again.' } }, $unset: { leaseExpiresAt: 1 } }
  );
  const stale = await TemplateGenerationJob.updateMany(
    { status: 'QUEUED', createdAt: { $lt: new Date(now.getTime() - QUEUE_TTL_MS) } },
    { $set: { status: 'FAILED', finishedAt: now, error: { code: 'EXPIRED', message: 'This generation waited too long to start. Please try again.' } } }
  );
  return stuck.modifiedCount + stale.modifiedCount;
}

/** Removes preview images of expired or deleted jobs that no saved template uses. Cheap, bounded and run at most every 6 hours. */
export async function sweepOrphanMedia(force = false): Promise<number> {
  if (!force && Date.now() - lastSweep < 6 * 3600 * 1000) return 0;
  lastSweep = Date.now();
  const candidates = await Media.find({ originalName: new RegExp(`^${MEDIA_PREFIX}`), createdAt: { $lt: new Date(Date.now() - JOB_TTL_MS - DAY_MS) } }).select('_id').limit(500).lean();
  let removed = 0;
  for (const m of candidates) {
    const key = `media:${m._id}`;
    if (await Template.exists({ previewImageKey: key })) continue;
    await Media.deleteOne({ _id: m._id });
    removed++;
  }
  return removed;
}

async function startOf(jobId: string): Promise<ITemplateGenerationJob | null> {
  const now = new Date();
  const lease = new Date(now.getTime() + env.STITCH_TIMEOUT_MS * 3 + 60000);
  return TemplateGenerationJob.findOneAndUpdate({ _id: jobId, status: 'QUEUED' }, { $set: { status: 'RUNNING', startedAt: now, leaseExpiresAt: lease } }, { new: true });
}

/** Starts as many queued jobs as the concurrency limit allows. */
export async function pump(): Promise<void> {
  await failExpiredJobs().catch(() => undefined);
  while (running < env.STITCH_MAX_CONCURRENT_JOBS) {
    const next = await TemplateGenerationJob.findOne({ status: 'QUEUED' }).sort({ createdAt: 1 }).select('_id').lean();
    if (!next) return;
    const job = await startOf(String(next._id));
    if (!job) continue; // another worker took it
    running++;
    const work = processJob(job)
      .catch((err) => console.error('[template-generation] Unexpected job failure:', err instanceof Error ? err.message : 'unknown'))
      .finally(() => {
        running--;
        inflight.delete(work);
        void pump();
      });
    inflight.add(work);
  }
  void sweepOrphanMedia().catch(() => undefined);
}

/** Resolves when every job started by this process has finished (used by tests and graceful shutdown). */
export async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await pump();
    if (inflight.size === 0) return;
    await Promise.allSettled([...inflight]);
  }
}

export async function recoverOnStartup(): Promise<void> {
  // A restart killed whatever was running: fail it now instead of waiting for the lease, then resume the queue
  await TemplateGenerationJob.updateMany(
    { status: 'RUNNING' },
    { $set: { status: 'FAILED', finishedAt: new Date(), error: { code: 'INTERRUPTED', message: 'This generation was interrupted by a server restart. Please try again.' } }, $unset: { leaseExpiresAt: 1 } }
  );
  await pump();
}

async function failJob(jobId: unknown, code: GenerationErrorCode, message: string) {
  await TemplateGenerationJob.updateOne({ _id: jobId, status: { $in: ['RUNNING', 'QUEUED'] } }, { $set: { status: 'FAILED', finishedAt: new Date(), error: { code, message } }, $unset: { leaseExpiresAt: 1 } });
}

async function storeMedia(ownerId: unknown, jobId: unknown, name: string, jpeg: Buffer, info: { width: number; height: number }): Promise<string> {
  const media = await Media.create({ ownerId, purpose: MediaPurpose.TEMPLATE, contentType: 'image/jpeg', size: jpeg.length, width: info.width, height: info.height, originalName: `${MEDIA_PREFIX}${jobId}:${name}`, data: jpeg });
  return `media:${media._id}`;
}

/** Validates the provider's screenshot, then re-encodes it: what is stored is our JPEG, never the provider's bytes. */
async function normalizeConcept(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  try {
    return await decodeConcept(png);
  } catch (err) {
    // not an image, truncated, or absurdly large: the provider's answer is unusable, not our failure
    throw err instanceof StitchProviderError ? err : new StitchProviderError('MALFORMED', 'Unusable concept image');
  }
}

async function decodeConcept(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const meta = await sharp(png, { failOn: 'error', limitInputPixels: 50_000_000 }).metadata();
  if (!meta.width || !meta.height || !['png', 'jpeg', 'webp'].includes(meta.format || '') || meta.width > 10000 || meta.height > 20000) throw new StitchProviderError('MALFORMED', 'Unusable concept image');
  const { data, info } = await sharp(png, { failOn: 'error', limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: CONCEPT_EDGE, height: CONCEPT_EDGE * 2, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function renderSamplePreviewJpeg(spec: DesignSpec): Promise<{ data: Buffer; width: number; height: number }> {
  const qr = await QRCode.toBuffer('https://example.org/sample-not-a-real-invitation', { errorCorrectionLevel: 'H', margin: 4, width: 480 });
  const scale = Math.min(1, 900 / spec.canvas.width);
  const out = await renderDesignSpec({ spec, texts: SAMPLE_TEXTS[spec.kind], qr, scale, showPlaceholders: true });
  const { data, info } = await sharp(out.png).flatten({ background: '#ffffff' }).jpeg({ quality: 86, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function buildVariant(job: ITemplateGenerationJob, art: StitchScreenArtifacts, index: number): Promise<IJobVariant> {
  const concept = await normalizeConcept(art.screenshot);
  const conceptImageKey = await storeMedia(job.ownerId, job._id, `concept-${index}`, concept.data, concept);
  const converted = await convertStitchDesign({ html: art.html, screenshot: art.screenshot, kind: job.kind, preset: job.preset as CanvasPresetId });
  const variant: IJobVariant = { index, projectId: art.projectId, screenId: art.screenId, conceptImageKey, ready: false, fidelity: 'NONE', notes: converted.notes };
  if (converted.ready && converted.spec) {
    const preview = await renderSamplePreviewJpeg(converted.spec);
    variant.previewImageKey = await storeMedia(job.ownerId, job._id, `preview-${index}`, preview.data, preview);
    variant.designSpec = converted.spec as unknown as Record<string, any>;
    variant.ready = true;
    variant.fidelity = converted.fidelity;
  }
  return variant;
}

function providerCall(job: ITemplateGenerationJob): Promise<StitchScreenArtifacts[]> {
  const provider = getStitchProvider();
  const preset = job.preset as CanvasPresetId;
  const device = deviceFor(preset);
  const prompt = buildStitchPrompt({ kind: job.kind, preset, prompt: job.prompt, style: job.style });
  if (job.mode === 'CREATE') return provider.generate({ title: `LGPSM ${job.kind.toLowerCase()} template`, prompt, device }).then((a) => [a]);
  return TemplateGenerationJob.findById(job.parentJobId)
    .lean()
    .then((parent) => {
      const source = parent?.variants.find((v) => v.index === job.parentVariantIndex);
      if (!source) throw new GenerationError('VARIANT_NOT_FOUND', 404, 'The design to change no longer exists');
      const ref = { projectId: source.projectId, screenId: source.screenId, device };
      if (job.mode === 'EDIT') return provider.edit({ ...ref, prompt: cleanPrompt(job.prompt) }).then((a) => [a]);
      return provider.variants({ ...ref, prompt: cleanPrompt(job.prompt), options: { count: job.variantCount, creativeRange: 'EXPLORE' } });
    });
}

async function processJob(job: ITemplateGenerationJob): Promise<void> {
  try {
    const artifacts = await providerCall(job);
    const variants: IJobVariant[] = [];
    for (const [i, art] of artifacts.slice(0, job.variantCount).entries()) variants.push(await buildVariant(job, art, i));
    if (variants.length === 0) throw new StitchProviderError('MALFORMED', 'No designs returned');
    const status = variants.some((v) => v.ready) ? 'SUCCEEDED' : 'CONCEPT_ONLY';
    const updated = await TemplateGenerationJob.findOneAndUpdate({ _id: job._id, status: 'RUNNING' }, { $set: { status, variants, finishedAt: new Date() }, $unset: { leaseExpiresAt: 1 } }, { new: true });
    // The job was deleted or failed (lease ran out) while the provider worked: do not leave its images behind
    if (!updated) await Media.deleteMany({ originalName: new RegExp(`^${MEDIA_PREFIX}${job._id}:`) });
  } catch (err) {
    if (err instanceof GenerationError) return failJob(job._id, err.code, err.message);
    if (err instanceof StitchProviderError) {
      const m = PROVIDER_MESSAGES[err.kind];
      if (err.kind === 'AUTH' || err.kind === 'NOT_CONFIGURED') console.error('[template-generation] Provider credentials were rejected or are missing');
      return failJob(job._id, m.code, m.message);
    }
    console.error('[template-generation] Generation failed:', err instanceof Error ? err.message : 'unknown error');
    return failJob(job._id, 'PROVIDER_FAILED', 'The design could not be created. Please try again.');
  }
}

// ---------- public API ----------

async function enqueue(actor: Actor, base: Omit<CreateJobInput, 'idempotencyKey'> & { mode: JobMode; parentJobId?: string; parentVariantIndex?: number; idempotencyKey?: string }) {
  if (!getStitchProvider().isConfigured()) throw new GenerationError('PROVIDER_UNAVAILABLE', 503, PROVIDER_MESSAGES.NOT_CONFIGURED.message);
  const preset = CANVAS_PRESETS[base.preset];
  if (!preset || preset.kind !== base.kind) throw new GenerationError('INVALID_REQUEST', 400, 'That size does not suit this kind of template');
  const prompt = cleanPrompt(base.prompt);
  if (prompt.length < 10) throw new GenerationError('INVALID_REQUEST', 400, 'Please describe the design in a little more detail');

  await failExpiredJobs();
  const ownerId = new mongoose.Types.ObjectId(actor.userId);
  const promptHash = hashOf(JSON.stringify([base.kind, base.preset, base.mode, base.parentJobId || '', base.parentVariantIndex ?? '', base.variantCount ?? 1, prompt.toLowerCase(), base.style || {}]));

  if (base.idempotencyKey) {
    const existing = await TemplateGenerationJob.findOne({ ownerId, idempotencyKey: base.idempotencyKey });
    if (existing) return { job: existing, deduplicated: true };
  }
  const active = await TemplateGenerationJob.findOne({ ownerId, status: { $in: ['QUEUED', 'RUNNING'] } });
  if (active) {
    if (active.promptHash === promptHash) return { job: active, deduplicated: true };
    throw new GenerationError('JOB_ACTIVE', 409, 'A design is already being generated. Wait for it to finish before starting another.');
  }

  // Daily quota counts runs that reached the provider, so failures caused by our own configuration do not use it up
  const used = await TemplateGenerationJob.countDocuments({ ownerId, startedAt: { $gte: new Date(Date.now() - DAY_MS) } });
  if (!isAdmin(actor) && used >= env.STITCH_DAILY_QUOTA_PER_USER) {
    const oldest = await TemplateGenerationJob.findOne({ ownerId, startedAt: { $gte: new Date(Date.now() - DAY_MS) } }).sort({ startedAt: 1 }).select('startedAt').lean();
    const retry = oldest?.startedAt ? Math.max(60, Math.ceil((oldest.startedAt.getTime() + DAY_MS - Date.now()) / 1000)) : 3600;
    throw new GenerationError('QUOTA_EXCEEDED', 429, `You have used today's ${env.STITCH_DAILY_QUOTA_PER_USER} design generations. Try again later.`, retry);
  }

  let job: ITemplateGenerationJob;
  try {
    job = await TemplateGenerationJob.create({
      ownerId,
      kind: base.kind,
      preset: base.preset,
      mode: base.mode,
      prompt,
      promptHash,
      style: base.style || {},
      variantCount: Math.min(Math.max(base.variantCount || 1, 1), 3),
      parentJobId: base.parentJobId ? new mongoose.Types.ObjectId(base.parentJobId) : undefined,
      parentVariantIndex: base.parentVariantIndex,
      idempotencyKey: base.idempotencyKey,
      expiresAt: new Date(Date.now() + JOB_TTL_MS)
    });
  } catch (err: any) {
    // two identical requests raced past the checks above: the unique index lets exactly one of them in
    if (err?.code === 11000 && base.idempotencyKey) {
      const existing = await TemplateGenerationJob.findOne({ ownerId, idempotencyKey: base.idempotencyKey });
      if (existing) return { job: existing, deduplicated: true };
    }
    throw err;
  }
  setImmediate(() => void pump().catch(() => undefined));
  return { job, deduplicated: false };
}

async function loadOwnedJob(actor: Actor, id: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new GenerationError('JOB_NOT_FOUND', 404, 'Generation not found');
  const job = await TemplateGenerationJob.findOne({ _id: id, ...ownerFilter(actor) });
  if (!job) throw new GenerationError('JOB_NOT_FOUND', 404, 'Generation not found');
  return job;
}

export const templateGenerationService = {
  createJob: (actor: Actor, input: CreateJobInput) => enqueue(actor, { ...input, mode: 'CREATE' }),

  async editVariant(actor: Actor, jobId: string, index: number, prompt: string, idempotencyKey?: string) {
    const parent = await loadOwnedJob(actor, jobId);
    const variant = parent.variants.find((v) => v.index === index);
    if (!variant) throw new GenerationError('VARIANT_NOT_FOUND', 404, 'Design not found');
    return enqueue(actor, { kind: parent.kind, preset: parent.preset as CanvasPresetId, prompt, style: parent.style as any, variantCount: 1, mode: 'EDIT', parentJobId: String(parent._id), parentVariantIndex: index, idempotencyKey });
  },

  async createVariations(actor: Actor, jobId: string, index: number, prompt: string, count: number, idempotencyKey?: string) {
    const parent = await loadOwnedJob(actor, jobId);
    const variant = parent.variants.find((v) => v.index === index);
    if (!variant) throw new GenerationError('VARIANT_NOT_FOUND', 404, 'Design not found');
    return enqueue(actor, { kind: parent.kind, preset: parent.preset as CanvasPresetId, prompt, style: parent.style as any, variantCount: count, mode: 'VARIATIONS', parentJobId: String(parent._id), parentVariantIndex: index, idempotencyKey });
  },

  async getJob(actor: Actor, id: string) {
    await failExpiredJobs();
    return loadOwnedJob(actor, id);
  },

  async listJobs(actor: Actor, options: { page?: number; limit?: number } = {}) {
    await failExpiredJobs();
    const page = Math.max(options.page || 1, 1);
    const limit = Math.min(Math.max(options.limit || 10, 1), 50);
    const filter = ownerFilter(actor);
    const [jobs, total] = await Promise.all([TemplateGenerationJob.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), TemplateGenerationJob.countDocuments(filter)]);
    return { jobs, total, page, limit };
  },

  async deleteJob(actor: Actor, id: string) {
    const job = await loadOwnedJob(actor, id);
    if (job.status === 'RUNNING') throw new GenerationError('JOB_ACTIVE', 409, 'This design is still being generated');
    const saved = await Template.find({ 'source.jobId': job._id, isActive: { $ne: false } }).select('previewImageKey').lean();
    const keep = new Set(saved.map((t) => t.previewImageKey).filter(Boolean));
    const keys = job.variants.flatMap((v) => [v.conceptImageKey, v.previewImageKey]).filter((k): k is string => !!k && !keep.has(k));
    await Media.deleteMany({ _id: { $in: keys.map((k) => k.replace(/^media:/, '')).filter((k) => mongoose.Types.ObjectId.isValid(k)) } });
    await job.deleteOne();
  },

  /**
   * Turns one converted variant into a template owned by the actor. Idempotent: saving the same variant twice returns
   * the template from the first save. A variant that could not be converted is never saved as a template.
   */
  async saveVariant(actor: Actor, jobId: string, index: number, input: { name: string; categoryId?: string; subcategoryId?: string; publish?: boolean }): Promise<{ template: ITemplate; alreadySaved: boolean }> {
    const job = await loadOwnedJob(actor, jobId);
    const variant = job.variants.find((v) => v.index === index);
    if (!variant) throw new GenerationError('VARIANT_NOT_FOUND', 404, 'Design not found');
    if (!variant.ready || !variant.designSpec) throw new GenerationError('NOT_CONVERTIBLE', 409, 'This concept could not be turned into a ready-to-use template. You can still view it, or ask for changes and generate again.');
    const parsed = safeParseDesignSpec(variant.designSpec);
    if (!parsed.ok) throw new GenerationError('NOT_CONVERTIBLE', 409, 'This design is no longer valid. Please generate it again.');

    if (variant.templateId) {
      const existing = await Template.findOne({ _id: variant.templateId, isActive: { $ne: false } });
      if (existing) return { template: existing, alreadySaved: true };
    }
    if (input.categoryId) {
      if (!(await Category.exists({ _id: input.categoryId }))) throw new GenerationError('INVALID_REQUEST', 400, 'Category not found');
    }

    const claimed = new mongoose.Types.ObjectId();
    const claim = await TemplateGenerationJob.updateOne(
      { _id: job._id, variants: { $elemMatch: { index, templateId: variant.templateId ? variant.templateId : { $exists: false } } } },
      { $set: { 'variants.$.templateId': claimed } }
    );
    if (claim.modifiedCount === 0) {
      // a concurrent save won the claim: return its template
      const fresh = await TemplateGenerationJob.findById(job._id).lean();
      const winner = fresh?.variants.find((v) => v.index === index)?.templateId;
      const existing = winner ? await Template.findOne({ _id: winner, isActive: { $ne: false } }) : null;
      if (existing) return { template: existing, alreadySaved: true };
      throw new GenerationError('JOB_ACTIVE', 409, 'This design is being saved. Please try again.');
    }

    try {
      const admin = isAdmin(actor);
      const template = await Template.create({
        _id: claimed,
        name: input.name,
        kind: parsed.spec.kind,
        cardDesign: 'CUSTOM',
        designSpec: parsed.spec,
        ownerId: new mongoose.Types.ObjectId(actor.userId),
        ...(input.categoryId ? { categoryId: input.categoryId } : {}),
        ...(input.subcategoryId ? { subcategoryId: input.subcategoryId } : {}),
        previewImageKey: variant.previewImageKey,
        source: { provider: 'STITCH', jobId: job._id, screenId: variant.screenId },
        // an admin's published template is available to every organizer; an organizer's is theirs alone
        isSystemTemplate: admin,
        isPublished: input.publish === true,
        isActive: true
      });
      return { template, alreadySaved: false };
    } catch (err) {
      // do not leave the variant pointing at a template that was never created
      await TemplateGenerationJob.updateOne({ _id: job._id, variants: { $elemMatch: { index, templateId: claimed } } }, { $unset: { 'variants.$.templateId': 1 } });
      throw err;
    }
  }
};

/** What a client may see of a job. Provider references and the stored specs stay on the server. */
export function serializeJob(job: ITemplateGenerationJob) {
  return {
    id: String(job._id),
    kind: job.kind,
    preset: job.preset,
    mode: job.mode,
    prompt: job.prompt,
    status: job.status,
    variantCount: job.variantCount,
    error: job.error?.code ? { code: job.error.code, message: job.error.message } : undefined,
    parentJobId: job.parentJobId ? String(job.parentJobId) : undefined,
    parentVariantIndex: job.parentVariantIndex,
    variants: (job.variants || []).map((v) => ({
      index: v.index,
      ready: v.ready,
      fidelity: v.fidelity,
      notes: v.notes,
      conceptImageKey: v.conceptImageKey,
      previewImageKey: v.previewImageKey,
      templateId: v.templateId ? String(v.templateId) : undefined
    })),
    createdAt: job.createdAt,
    finishedAt: job.finishedAt
  };
}
