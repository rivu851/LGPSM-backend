"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateGenerationService = exports.cleanPrompt = exports.GenerationError = void 0;
exports.deviceFor = deviceFor;
exports.buildStitchPrompt = buildStitchPrompt;
exports.failExpiredJobs = failExpiredJobs;
exports.sweepOrphanMedia = sweepOrphanMedia;
exports.pump = pump;
exports.drain = drain;
exports.recoverOnStartup = recoverOnStartup;
exports.renderSamplePreviewJpeg = renderSamplePreviewJpeg;
exports.usageFor = usageFor;
exports.serializeUsage = serializeUsage;
exports.serializeJob = serializeJob;
const crypto_1 = __importDefault(require("crypto"));
const mongoose_1 = __importDefault(require("mongoose"));
const sharp_1 = __importDefault(require("sharp"));
const qrcode_1 = __importDefault(require("qrcode"));
const env_1 = require("../../config/env");
const Media_1 = require("../../models/Media");
const Template_1 = require("../../models/Template");
const Category_1 = require("../../models/Category");
const TemplateGenerationJob_1 = require("../../models/TemplateGenerationJob");
const User_1 = require("../../models/User");
const designSpec_1 = require("../cardTemplates/designSpec");
const specRenderer_1 = require("../cardTemplates/specRenderer");
const stitch_converter_1 = require("./stitch.converter");
const sampleData_1 = require("./sampleData");
const stitch_provider_1 = require("./stitch.provider");
class GenerationError extends Error {
    code;
    status;
    retryAfterSeconds;
    constructor(code, status, message, retryAfterSeconds) {
        super(message);
        this.code = code;
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}
exports.GenerationError = GenerationError;
const JOB_TTL_MS = 7 * 24 * 3600 * 1000;
const QUEUE_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const CONCEPT_EDGE = 900;
const MEDIA_PREFIX = 'ai-template:';
const PROVIDER_MESSAGES = {
    NOT_CONFIGURED: { code: 'PROVIDER_UNAVAILABLE', message: 'AI template generation is not available right now.' },
    AUTH: { code: 'PROVIDER_AUTH', message: 'AI template generation is temporarily unavailable. Our team has been notified.' },
    QUOTA: { code: 'PROVIDER_QUOTA', message: 'The design service is busy right now. Please try again in a while.' },
    NETWORK: { code: 'PROVIDER_NETWORK', message: 'The design service could not be reached. Please try again.' },
    TIMEOUT: { code: 'PROVIDER_TIMEOUT', message: 'The design service took too long. Please try again.' },
    MALFORMED: { code: 'BAD_PROVIDER_RESPONSE', message: 'The design service returned something we could not use. Please try again.' },
    PROVIDER: { code: 'PROVIDER_FAILED', message: 'The design service could not create this design. Try rephrasing your request.' }
};
const isAdmin = (a) => a.role === User_1.Role.ADMIN || a.role === 'ADMIN';
const ownerFilter = (a) => (isAdmin(a) ? {} : { ownerId: new mongoose_1.default.Types.ObjectId(a.userId) });
// ---------- prompt ----------
// eslint-disable-next-line no-control-regex
const cleanPrompt = (t) => t.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
exports.cleanPrompt = cleanPrompt;
function deviceFor(preset) {
    const { width, height } = designSpec_1.CANVAS_PRESETS[preset];
    const aspect = width / height;
    return aspect > 1.3 ? 'DESKTOP' : aspect >= 0.8 ? 'TABLET' : 'MOBILE';
}
function buildStitchPrompt(input) {
    const { width, height } = designSpec_1.CANVAS_PRESETS[input.preset];
    const what = input.kind === 'INVITATION' ? 'a personal event invitation card' : 'an event poster';
    const zones = input.kind === 'INVITATION'
        ? 'event title, a short description, date and time, venue, the organizer name or logo, the invited guest\'s name, and a large square QR-code area with a white background for entrance check-in'
        : 'event title, a short description, date and time, venue, the organizer name or logo, and a large square QR-code area with a white background for registration';
    const style = [input.style?.mood ? `mood: ${input.style.mood}` : '', input.style?.colorHint ? `colours: ${input.style.colorHint}` : ''].filter(Boolean).join('; ');
    return [
        `Design ${what} template as ONE static screen with aspect ratio ${(width / height).toFixed(2)} (${width}x${height}). Make it as an HTML page. It is a printable/shareable layout, not an app screen: no navigation bars, buttons, menus or scrolling.`,
        `Clear zones for: ${zones}. Use only generic placeholder wording and no real people, brands or phone numbers.`,
        style ? `Style preferences - ${style}.` : '',
        `Creative brief from the organizer: ${(0, exports.cleanPrompt)(input.prompt)}`
    ]
        .filter(Boolean)
        .join('\n');
}
const hashOf = (s) => crypto_1.default.createHash('sha256').update(s).digest('hex').slice(0, 32);
// ---------- job lifecycle ----------
const inflight = new Set();
let running = 0;
let lastSweep = 0;
/** Fails jobs that can no longer finish: a run whose lease ran out (the process died or hung) and a job that waited too long. */
async function failExpiredJobs(now = new Date()) {
    const stuck = await TemplateGenerationJob_1.TemplateGenerationJob.updateMany({ status: 'RUNNING', leaseExpiresAt: { $lt: now } }, { $set: { status: 'FAILED', finishedAt: now, error: { code: 'INTERRUPTED', message: 'This generation did not finish. Please try again.' } }, $unset: { leaseExpiresAt: 1 } });
    const stale = await TemplateGenerationJob_1.TemplateGenerationJob.updateMany({ status: 'QUEUED', createdAt: { $lt: new Date(now.getTime() - QUEUE_TTL_MS) } }, { $set: { status: 'FAILED', finishedAt: now, error: { code: 'EXPIRED', message: 'This generation waited too long to start. Please try again.' } } });
    return stuck.modifiedCount + stale.modifiedCount;
}
/** Removes preview images of expired or deleted jobs that no saved template uses. Cheap, bounded and run at most every 6 hours. */
async function sweepOrphanMedia(force = false) {
    if (!force && Date.now() - lastSweep < 6 * 3600 * 1000)
        return 0;
    lastSweep = Date.now();
    const candidates = await Media_1.Media.find({ originalName: new RegExp(`^${MEDIA_PREFIX}`), createdAt: { $lt: new Date(Date.now() - JOB_TTL_MS - DAY_MS) } }).select('_id').limit(500).lean();
    let removed = 0;
    for (const m of candidates) {
        const key = `media:${m._id}`;
        if (await Template_1.Template.exists({ previewImageKey: key }))
            continue;
        await Media_1.Media.deleteOne({ _id: m._id });
        removed++;
    }
    return removed;
}
async function startOf(jobId) {
    const now = new Date();
    const lease = new Date(now.getTime() + env_1.env.STITCH_TIMEOUT_MS * 3 + 60000);
    return TemplateGenerationJob_1.TemplateGenerationJob.findOneAndUpdate({ _id: jobId, status: 'QUEUED' }, { $set: { status: 'RUNNING', startedAt: now, leaseExpiresAt: lease } }, { new: true });
}
/** Starts as many queued jobs as the concurrency limit allows. */
async function pump() {
    await failExpiredJobs().catch(() => undefined);
    while (running < env_1.env.STITCH_MAX_CONCURRENT_JOBS) {
        const next = await TemplateGenerationJob_1.TemplateGenerationJob.findOne({ status: 'QUEUED' }).sort({ createdAt: 1 }).select('_id').lean();
        if (!next)
            return;
        const job = await startOf(String(next._id));
        if (!job)
            continue; // another worker took it
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
async function drain() {
    for (let i = 0; i < 50; i++) {
        await pump();
        if (inflight.size === 0)
            return;
        await Promise.allSettled([...inflight]);
    }
}
async function recoverOnStartup() {
    // A restart killed whatever was running: fail it now instead of waiting for the lease, then resume the queue
    await TemplateGenerationJob_1.TemplateGenerationJob.updateMany({ status: 'RUNNING' }, { $set: { status: 'FAILED', finishedAt: new Date(), error: { code: 'INTERRUPTED', message: 'This generation was interrupted by a server restart. Please try again.' } }, $unset: { leaseExpiresAt: 1 } });
    await pump();
}
async function failJob(jobId, code, message) {
    await TemplateGenerationJob_1.TemplateGenerationJob.updateOne({ _id: jobId, status: { $in: ['RUNNING', 'QUEUED'] } }, { $set: { status: 'FAILED', finishedAt: new Date(), error: { code, message } }, $unset: { leaseExpiresAt: 1 } });
}
async function storeMedia(ownerId, jobId, name, jpeg, info) {
    const media = await Media_1.Media.create({ ownerId, purpose: Media_1.MediaPurpose.TEMPLATE, contentType: 'image/jpeg', size: jpeg.length, width: info.width, height: info.height, originalName: `${MEDIA_PREFIX}${jobId}:${name}`, data: jpeg });
    return `media:${media._id}`;
}
/** Validates the provider's screenshot, then re-encodes it: what is stored is our JPEG, never the provider's bytes. */
async function normalizeConcept(png) {
    try {
        return await decodeConcept(png);
    }
    catch (err) {
        // not an image, truncated, or absurdly large: the provider's answer is unusable, not our failure
        throw err instanceof stitch_provider_1.StitchProviderError ? err : new stitch_provider_1.StitchProviderError('MALFORMED', `Unusable concept image (${err instanceof Error ? err.message.slice(0, 80) : 'unknown'})`);
    }
}
async function decodeConcept(png) {
    const meta = await (0, sharp_1.default)(png, { failOn: 'error', limitInputPixels: 50_000_000 }).metadata();
    if (!meta.width || !meta.height || !['png', 'jpeg', 'webp'].includes(meta.format || '') || meta.width > 10000 || meta.height > 20000)
        throw new stitch_provider_1.StitchProviderError('MALFORMED', 'Unusable concept image');
    const { data, info } = await (0, sharp_1.default)(png, { failOn: 'error', limitInputPixels: 50_000_000 })
        .rotate()
        .resize({ width: CONCEPT_EDGE, height: CONCEPT_EDGE * 2, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
}
async function renderSamplePreviewJpeg(spec) {
    const qr = await qrcode_1.default.toBuffer('https://example.org/sample-not-a-real-invitation', { errorCorrectionLevel: 'H', margin: 4, width: 480 });
    const scale = Math.min(1, 900 / spec.canvas.width);
    const out = await (0, specRenderer_1.renderDesignSpec)({ spec, texts: sampleData_1.SAMPLE_TEXTS[spec.kind], qr, scale, showPlaceholders: true });
    const { data, info } = await (0, sharp_1.default)(out.png).flatten({ background: '#ffffff' }).jpeg({ quality: 86, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
}
async function buildVariant(job, art, index) {
    const concept = await normalizeConcept(art.screenshot);
    const conceptImageKey = await storeMedia(job.ownerId, job._id, `concept-${index}`, concept.data, concept);
    const converted = await (0, stitch_converter_1.convertStitchDesign)({ html: art.html, screenshot: art.screenshot, kind: job.kind, preset: job.preset });
    const variant = { index, projectId: art.projectId, screenId: art.screenId, conceptImageKey, ready: false, fidelity: 'NONE', notes: converted.notes };
    if (converted.ready && converted.spec) {
        const preview = await renderSamplePreviewJpeg(converted.spec);
        variant.previewImageKey = await storeMedia(job.ownerId, job._id, `preview-${index}`, preview.data, preview);
        variant.designSpec = converted.spec;
        variant.ready = true;
        variant.fidelity = converted.fidelity;
    }
    return variant;
}
/**
 * One more try for problems that are usually momentary (the provider hiccuped, an answer was unusable, the connection
 * dropped). Never for credentials, quota or a timeout: retrying those cannot help and only costs allowance or time.
 */
async function withOneRetry(call) {
    try {
        return await call();
    }
    catch (err) {
        if (!(err instanceof stitch_provider_1.StitchProviderError) || !['MALFORMED', 'PROVIDER', 'NETWORK'].includes(err.kind))
            throw err;
        console.warn(`[template-generation] Retrying once after ${err.kind}: ${err.message}`);
        return call();
    }
}
function providerCall(job) {
    const provider = (0, stitch_provider_1.getStitchProvider)();
    const preset = job.preset;
    const device = deviceFor(preset);
    const prompt = buildStitchPrompt({ kind: job.kind, preset, prompt: job.prompt, style: job.style });
    if (job.mode === 'CREATE') {
        return withOneRetry(() => provider.generate({ title: `LGPSM ${job.kind.toLowerCase()} template`, prompt, device })).then(async (first) => {
            if (job.variantCount <= 1)
                return [first];
            // One generation makes one design. The extra options are genuine alternatives of it from the provider's own
            // variations call; if that fails we still return the first design and the job reports fewer than requested.
            try {
                const extra = await provider.variants({
                    projectId: first.projectId,
                    screenId: first.screenId,
                    prompt: `Create a clearly different alternative of this design (different layout and colour treatment). Original brief: ${(0, exports.cleanPrompt)(job.prompt)}`,
                    device,
                    options: { count: job.variantCount - 1, creativeRange: 'EXPLORE' }
                });
                return [first, ...extra.slice(0, job.variantCount - 1)];
            }
            catch (err) {
                console.warn('[template-generation] Extra options could not be created:', err instanceof stitch_provider_1.StitchProviderError ? err.kind : 'unknown error');
                return [first];
            }
        });
    }
    const sourceOf = async () => {
        if (job.parentTemplateId) {
            const t = await Template_1.Template.findById(job.parentTemplateId).select('source').lean();
            return t?.source?.projectId && t.source.screenId ? { projectId: t.source.projectId, screenId: t.source.screenId } : undefined;
        }
        const parent = await TemplateGenerationJob_1.TemplateGenerationJob.findById(job.parentJobId).lean();
        return parent?.variants.find((v) => v.index === job.parentVariantIndex);
    };
    return sourceOf()
        .then((source) => {
        if (!source)
            throw new GenerationError('VARIANT_NOT_FOUND', 404, 'The design to change no longer exists');
        const ref = { projectId: source.projectId, screenId: source.screenId, device };
        if (job.mode === 'EDIT')
            return provider.edit({ ...ref, prompt: (0, exports.cleanPrompt)(job.prompt) }).then((a) => [a]);
        return provider.variants({ ...ref, prompt: (0, exports.cleanPrompt)(job.prompt), options: { count: job.variantCount, creativeRange: 'EXPLORE' } });
    });
}
async function processJob(job) {
    try {
        const artifacts = await providerCall(job);
        const variants = [];
        for (const [i, art] of artifacts.slice(0, job.variantCount).entries())
            variants.push(await buildVariant(job, art, i));
        if (variants.length === 0)
            throw new stitch_provider_1.StitchProviderError('MALFORMED', 'No designs returned');
        const status = variants.some((v) => v.ready) ? 'SUCCEEDED' : 'CONCEPT_ONLY';
        const updated = await TemplateGenerationJob_1.TemplateGenerationJob.findOneAndUpdate({ _id: job._id, status: 'RUNNING' }, { $set: { status, variants, finishedAt: new Date() }, $unset: { leaseExpiresAt: 1 } }, { new: true });
        // The job was deleted or failed (lease ran out) while the provider worked: do not leave its images behind
        if (!updated)
            await Media_1.Media.deleteMany({ originalName: new RegExp(`^${MEDIA_PREFIX}${job._id}:`) });
    }
    catch (err) {
        if (err instanceof GenerationError)
            return failJob(job._id, err.code, err.message);
        if (err instanceof stitch_provider_1.StitchProviderError) {
            const m = PROVIDER_MESSAGES[err.kind];
            // our own wording only (never the credential or the provider's text), so the logs say which step failed
            console.error(`[template-generation] Job failed (${err.kind}): ${err.message}`);
            return failJob(job._id, m.code, m.message);
        }
        console.error('[template-generation] Generation failed:', err instanceof Error ? err.message : 'unknown error');
        return failJob(job._id, 'PROVIDER_FAILED', 'The design could not be created. Please try again.');
    }
}
// ---------- public API ----------
async function enqueue(actor, base) {
    if (!(0, stitch_provider_1.getStitchProvider)().isConfigured())
        throw new GenerationError('PROVIDER_UNAVAILABLE', 503, PROVIDER_MESSAGES.NOT_CONFIGURED.message);
    const preset = designSpec_1.CANVAS_PRESETS[base.preset];
    if (!preset || preset.kind !== base.kind)
        throw new GenerationError('INVALID_REQUEST', 400, 'That size does not suit this kind of template');
    const prompt = (0, exports.cleanPrompt)(base.prompt);
    if (prompt.length < 10)
        throw new GenerationError('INVALID_REQUEST', 400, 'Please describe the design in a little more detail');
    await failExpiredJobs();
    const ownerId = new mongoose_1.default.Types.ObjectId(actor.userId);
    const promptHash = hashOf(JSON.stringify([base.kind, base.preset, base.mode, base.parentJobId || '', base.parentVariantIndex ?? '', base.parentTemplateId || '', base.variantCount ?? 1, prompt.toLowerCase(), base.style || {}]));
    if (base.idempotencyKey) {
        const existing = await TemplateGenerationJob_1.TemplateGenerationJob.findOne({ ownerId, idempotencyKey: base.idempotencyKey });
        if (existing)
            return { job: existing, deduplicated: true };
    }
    const active = await TemplateGenerationJob_1.TemplateGenerationJob.findOne({ ownerId, status: { $in: ['QUEUED', 'RUNNING'] } });
    if (active) {
        if (active.promptHash === promptHash)
            return { job: active, deduplicated: true };
        throw new GenerationError('JOB_ACTIVE', 409, 'A design is already being generated. Wait for it to finish before starting another.');
    }
    // Daily quota counts requests that reached (or are waiting for) the provider, so failures caused by our own
    // configuration do not use it up
    const usage = await usageFor(actor);
    if (usage.limit !== null && usage.remaining <= 0) {
        const retry = usage.resetsAt ? Math.max(60, Math.ceil((usage.resetsAt.getTime() - Date.now()) / 1000)) : 3600;
        throw new GenerationError('QUOTA_EXCEEDED', 429, `You have used today's ${usage.limit} design generations. Try again later.`, retry);
    }
    let job;
    try {
        job = await TemplateGenerationJob_1.TemplateGenerationJob.create({
            ownerId,
            kind: base.kind,
            preset: base.preset,
            mode: base.mode,
            prompt,
            promptHash,
            style: base.style || {},
            variantCount: Math.min(Math.max(base.variantCount || 1, 1), 3),
            parentJobId: base.parentJobId ? new mongoose_1.default.Types.ObjectId(base.parentJobId) : undefined,
            parentVariantIndex: base.parentVariantIndex,
            parentTemplateId: base.parentTemplateId ? new mongoose_1.default.Types.ObjectId(base.parentTemplateId) : undefined,
            idempotencyKey: base.idempotencyKey,
            expiresAt: new Date(Date.now() + JOB_TTL_MS)
        });
    }
    catch (err) {
        // two identical requests raced past the checks above: the unique index lets exactly one of them in
        if (err?.code === 11000 && base.idempotencyKey) {
            const existing = await TemplateGenerationJob_1.TemplateGenerationJob.findOne({ ownerId, idempotencyKey: base.idempotencyKey });
            if (existing)
                return { job: existing, deduplicated: true };
        }
        throw err;
    }
    setImmediate(() => void pump().catch(() => undefined));
    return { job, deduplicated: false };
}
const countedSince = (since) => ({ createdAt: { $gte: since }, $or: [{ startedAt: { $exists: true } }, { status: { $in: ['QUEUED', 'RUNNING'] } }] });
/** How many generations the actor has used in the last 24 hours and how many are left. */
async function usageFor(actor) {
    const since = new Date(Date.now() - DAY_MS);
    const filter = { ownerId: new mongoose_1.default.Types.ObjectId(actor.userId), ...countedSince(since) };
    const used = await TemplateGenerationJob_1.TemplateGenerationJob.countDocuments(filter);
    if (isAdmin(actor))
        return { used, limit: null, remaining: Number.MAX_SAFE_INTEGER, resetsAt: null };
    const limit = env_1.env.STITCH_DAILY_QUOTA_PER_USER;
    const oldest = used >= limit ? await TemplateGenerationJob_1.TemplateGenerationJob.findOne(filter).sort({ createdAt: 1 }).select('createdAt').lean() : null;
    return { used, limit, remaining: Math.max(0, limit - used), resetsAt: oldest ? new Date(oldest.createdAt.getTime() + DAY_MS) : null };
}
function serializeUsage(u) {
    return { used: u.used, limit: u.limit, remaining: u.limit === null ? null : u.remaining, resetsAt: u.resetsAt };
}
async function loadOwnedJob(actor, id) {
    if (!mongoose_1.default.Types.ObjectId.isValid(id))
        throw new GenerationError('JOB_NOT_FOUND', 404, 'Generation not found');
    const job = await TemplateGenerationJob_1.TemplateGenerationJob.findOne({ _id: id, ...ownerFilter(actor) });
    if (!job)
        throw new GenerationError('JOB_NOT_FOUND', 404, 'Generation not found');
    return job;
}
exports.templateGenerationService = {
    createJob: (actor, input) => enqueue(actor, { ...input, mode: 'CREATE' }),
    async editVariant(actor, jobId, index, prompt, idempotencyKey) {
        const parent = await loadOwnedJob(actor, jobId);
        const variant = parent.variants.find((v) => v.index === index);
        if (!variant)
            throw new GenerationError('VARIANT_NOT_FOUND', 404, 'Design not found');
        return enqueue(actor, { kind: parent.kind, preset: parent.preset, prompt, style: parent.style, variantCount: 1, mode: 'EDIT', parentJobId: String(parent._id), parentVariantIndex: index, idempotencyKey });
    },
    /**
     * Changes a design that is already saved as a template, from a written request. The result is a new job whose options
     * can replace the template (save with `replaceTemplateId`) or be saved as a new one. Only the owner (or an admin).
     */
    async editTemplate(actor, templateId, prompt, idempotencyKey) {
        if (!mongoose_1.default.Types.ObjectId.isValid(templateId))
            throw new GenerationError('JOB_NOT_FOUND', 404, 'Template not found');
        const template = await Template_1.Template.findOne({ _id: templateId, isActive: { $ne: false }, ...(isAdmin(actor) ? {} : { ownerId: actor.userId }) }).lean();
        if (!template || template.cardDesign !== 'CUSTOM')
            throw new GenerationError('JOB_NOT_FOUND', 404, 'Template not found');
        if (!template.source?.projectId || !template.source.screenId) {
            throw new GenerationError('NOT_EDITABLE', 409, 'This template was saved before editing was available, so it cannot be changed with AI. Generate a new design instead.');
        }
        const preset = template.designSpec?.canvas?.preset;
        const kind = template.kind === 'POSTER' ? 'POSTER' : 'INVITATION';
        return enqueue(actor, { kind, preset: preset && designSpec_1.CANVAS_PRESETS[preset]?.kind === kind ? preset : kind === 'POSTER' ? 'POSTER_PORTRAIT' : 'INVITATION_PORTRAIT', prompt, variantCount: 1, mode: 'EDIT', parentTemplateId: String(template._id), idempotencyKey });
    },
    async createVariations(actor, jobId, index, prompt, count, idempotencyKey) {
        const parent = await loadOwnedJob(actor, jobId);
        const variant = parent.variants.find((v) => v.index === index);
        if (!variant)
            throw new GenerationError('VARIANT_NOT_FOUND', 404, 'Design not found');
        return enqueue(actor, { kind: parent.kind, preset: parent.preset, prompt, style: parent.style, variantCount: count, mode: 'VARIATIONS', parentJobId: String(parent._id), parentVariantIndex: index, idempotencyKey });
    },
    async getJob(actor, id) {
        await failExpiredJobs();
        return loadOwnedJob(actor, id);
    },
    async listJobs(actor, options = {}) {
        await failExpiredJobs();
        const page = Math.max(options.page || 1, 1);
        const limit = Math.min(Math.max(options.limit || 10, 1), 50);
        const filter = ownerFilter(actor);
        const [jobs, total] = await Promise.all([TemplateGenerationJob_1.TemplateGenerationJob.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), TemplateGenerationJob_1.TemplateGenerationJob.countDocuments(filter)]);
        return { jobs, total, page, limit };
    },
    async deleteJob(actor, id) {
        const job = await loadOwnedJob(actor, id);
        if (job.status === 'RUNNING')
            throw new GenerationError('JOB_ACTIVE', 409, 'This design is still being generated');
        const saved = await Template_1.Template.find({ 'source.jobId': job._id, isActive: { $ne: false } }).select('previewImageKey').lean();
        const keep = new Set(saved.map((t) => t.previewImageKey).filter(Boolean));
        const keys = job.variants.flatMap((v) => [v.conceptImageKey, v.previewImageKey]).filter((k) => !!k && !keep.has(k));
        await Media_1.Media.deleteMany({ _id: { $in: keys.map((k) => k.replace(/^media:/, '')).filter((k) => mongoose_1.default.Types.ObjectId.isValid(k)) } });
        await job.deleteOne();
    },
    /**
     * Turns one converted variant into a template owned by the actor. Idempotent: saving the same variant twice returns
     * the template from the first save. A variant that could not be converted is never saved as a template.
     */
    async saveVariant(actor, jobId, index, input) {
        const job = await loadOwnedJob(actor, jobId);
        const variant = job.variants.find((v) => v.index === index);
        if (!variant)
            throw new GenerationError('VARIANT_NOT_FOUND', 404, 'Design not found');
        if (!variant.ready || !variant.designSpec)
            throw new GenerationError('NOT_CONVERTIBLE', 409, 'This concept could not be turned into a ready-to-use template. You can still view it, or ask for changes and generate again.');
        const parsed = (0, designSpec_1.safeParseDesignSpec)(variant.designSpec);
        if (!parsed.ok)
            throw new GenerationError('NOT_CONVERTIBLE', 409, 'This design is no longer valid. Please generate it again.');
        if (variant.templateId) {
            const existing = await Template_1.Template.findOne({ _id: variant.templateId, isActive: { $ne: false } });
            if (existing)
                return { template: existing, alreadySaved: true };
        }
        // Replace an existing template with this design (editing a saved design). Same kind, and only the owner's (or an admin's).
        if (input.replaceTemplateId) {
            if (!mongoose_1.default.Types.ObjectId.isValid(input.replaceTemplateId))
                throw new GenerationError('INVALID_REQUEST', 400, 'Template not found');
            const target = await Template_1.Template.findOne({ _id: input.replaceTemplateId, isActive: { $ne: false }, cardDesign: 'CUSTOM', ...(isAdmin(actor) ? {} : { ownerId: actor.userId }) });
            if (!target)
                throw new GenerationError('JOB_NOT_FOUND', 404, 'Template not found');
            if (target.kind !== parsed.spec.kind)
                throw new GenerationError('INVALID_REQUEST', 400, 'A poster cannot replace an invitation (or the other way round)');
            const claimedReplace = await TemplateGenerationJob_1.TemplateGenerationJob.updateOne({ _id: job._id, variants: { $elemMatch: { index, templateId: { $exists: false } } } }, { $set: { 'variants.$.templateId': target._id } });
            if (claimedReplace.modifiedCount === 0)
                throw new GenerationError('JOB_ACTIVE', 409, 'This design is already being saved. Please try again.');
            const oldPreview = target.previewImageKey;
            target.designSpec = parsed.spec;
            target.previewImageKey = variant.previewImageKey;
            target.source = { provider: 'STITCH', jobId: job._id, projectId: variant.projectId, screenId: variant.screenId };
            if (input.name)
                target.name = input.name;
            target.markModified('designSpec');
            await target.save();
            // the replaced design's preview picture is no longer used by anything
            if (oldPreview && oldPreview !== variant.previewImageKey && !(await Template_1.Template.exists({ previewImageKey: oldPreview, _id: { $ne: target._id } }))) {
                const mediaId = oldPreview.replace(/^media:/, '');
                if (mongoose_1.default.Types.ObjectId.isValid(mediaId))
                    await Media_1.Media.deleteOne({ _id: mediaId, originalName: new RegExp(`^${MEDIA_PREFIX}`) });
            }
            return { template: target, alreadySaved: false, replaced: true };
        }
        if (input.categoryId) {
            if (!(await Category_1.Category.exists({ _id: input.categoryId })))
                throw new GenerationError('INVALID_REQUEST', 400, 'Category not found');
        }
        const claimed = new mongoose_1.default.Types.ObjectId();
        const claim = await TemplateGenerationJob_1.TemplateGenerationJob.updateOne({ _id: job._id, variants: { $elemMatch: { index, templateId: variant.templateId ? variant.templateId : { $exists: false } } } }, { $set: { 'variants.$.templateId': claimed } });
        if (claim.modifiedCount === 0) {
            // a concurrent save won the claim: return its template
            const fresh = await TemplateGenerationJob_1.TemplateGenerationJob.findById(job._id).lean();
            const winner = fresh?.variants.find((v) => v.index === index)?.templateId;
            const existing = winner ? await Template_1.Template.findOne({ _id: winner, isActive: { $ne: false } }) : null;
            if (existing)
                return { template: existing, alreadySaved: true };
            throw new GenerationError('JOB_ACTIVE', 409, 'This design is being saved. Please try again.');
        }
        try {
            const admin = isAdmin(actor);
            const template = await Template_1.Template.create({
                _id: claimed,
                name: input.name,
                kind: parsed.spec.kind,
                cardDesign: 'CUSTOM',
                designSpec: parsed.spec,
                ownerId: new mongoose_1.default.Types.ObjectId(actor.userId),
                ...(input.categoryId ? { categoryId: input.categoryId } : {}),
                ...(input.subcategoryId ? { subcategoryId: input.subcategoryId } : {}),
                previewImageKey: variant.previewImageKey,
                source: { provider: 'STITCH', jobId: job._id, projectId: variant.projectId, screenId: variant.screenId },
                // an admin's published template is available to every organizer; an organizer's is theirs alone
                isSystemTemplate: admin,
                isPublished: input.publish === true,
                isActive: true
            });
            return { template, alreadySaved: false };
        }
        catch (err) {
            // do not leave the variant pointing at a template that was never created
            await TemplateGenerationJob_1.TemplateGenerationJob.updateOne({ _id: job._id, variants: { $elemMatch: { index, templateId: claimed } } }, { $unset: { 'variants.$.templateId': 1 } });
            throw err;
        }
    }
};
/** What a client may see of a job. Provider references and the stored specs stay on the server. */
function serializeJob(job) {
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
        parentTemplateId: job.parentTemplateId ? String(job.parentTemplateId) : undefined,
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
