"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cardJobService = void 0;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const mongoose_1 = __importDefault(require("mongoose"));
const archiver_1 = __importDefault(require("archiver"));
const kv_1 = require("../infra/kv");
const Invitee_1 = require("../models/Invitee");
const Session_1 = require("../models/Session");
const CardDownloadPlan_1 = require("../models/CardDownloadPlan");
const cardDownload_service_1 = require("./cardDownload.service");
/**
 * Printable cards as ONE download. The cards are built in the background (so no web request runs for minutes, which a shared host would cut
 * off), the person watches the progress, and when it is ready they download a single zip. For more than 100 guests that zip holds the
 * smaller zips (at most 100 guests each); up to 100 guests it holds the PDFs directly.
 *
 * Jobs live in this server process (the key-value store keeps their status, the file sits on this server's disk), which fits one server.
 * A restart loses a running job; the person is told and starts again. Finished files are removed after 30 minutes.
 */
const DIR = process.env.CARD_TMP_DIR || path_1.default.join(os_1.default.tmpdir(), 'eqr-cards');
const STATUS_TTL_MS = 2 * 60 * 60_000;
const FILE_KEEP_MS = 30 * 60_000;
const STALLED_AFTER_MS = 90_000;
const TICKET_MS = 5 * 60_000;
const maxRunning = () => Math.max(1, Math.floor(Number(process.env.CARD_JOBS_MAX)) || 2);
let running = 0;
const jobKey = (id) => `cj:${id}`;
async function save(job) { job.updatedAt = Date.now(); await kv_1.kv.set(jobKey(job.id), JSON.stringify(job), STATUS_TTL_MS).catch(() => undefined); }
async function load(id) { const t = await kv_1.kv.get(jobKey(id)); return t ? JSON.parse(t) : null; }
/** Files left behind by an earlier run of the server (a restart mid-job) are removed the first time a job is started */
let swept = false;
async function sweepOldFiles() {
    if (swept)
        return;
    swept = true;
    try {
        for (const f of await fs_1.default.promises.readdir(DIR)) {
            const p = path_1.default.join(DIR, f);
            const st = await fs_1.default.promises.stat(p);
            if (Date.now() - st.mtimeMs > STATUS_TTL_MS)
                await fs_1.default.promises.rm(p, { force: true });
        }
    }
    catch { /* the folder does not exist yet */ }
}
exports.cardJobService = {
    /** Starts building the cards for a plan. Returns at once; the work goes on in the background. */
    async start(actor, eventId, planId) {
        const event = await (0, cardDownload_service_1.loadEvent)(actor, eventId);
        const plan = mongoose_1.default.Types.ObjectId.isValid(planId) ? await CardDownloadPlan_1.CardDownloadPlan.findOne({ _id: planId, eventId, userId: actor.userId }).lean() : null;
        if (!plan)
            throw (0, cardDownload_service_1.fail)(404, 'This download has expired. Please start it again.', 'PLAN_EXPIRED');
        // one at a time per person (a second tap attaches to the first), and a few at a time on the whole server
        const activeKey = `cj:active:${actor.userId}`;
        const existingId = await kv_1.kv.get(activeKey);
        if (existingId) {
            const existing = await load(existingId);
            if (existing && existing.status === 'RUNNING' && Date.now() - existing.updatedAt < STALLED_AFTER_MS) {
                throw Object.assign((0, cardDownload_service_1.fail)(409, 'Your cards are already being prepared.', 'JOB_ALREADY_RUNNING'), { jobId: existing.id });
            }
        }
        if (running >= maxRunning())
            throw (0, cardDownload_service_1.fail)(429, 'We are preparing cards for other people right now. Please try again in a minute.', 'SERVER_BUSY');
        const sizes = (0, cardDownload_service_1.zipSizes)(plan.inviteeIds.length);
        const sess = plan.sessionId ? await Session_1.Session.findOne({ _id: plan.sessionId, eventId }).select('name').lean() : null;
        const job = {
            id: crypto_1.default.randomBytes(12).toString('hex'), userId: actor.userId, eventId, status: 'RUNNING',
            total: plan.inviteeIds.length, zips: sizes.length, doneGuests: 0, doneParts: 0,
            fileName: (0, cardDownload_service_1.zipFileNames)(event.title, sess ? sess.name : null, 1)[0], nested: sizes.length > 1,
            startedAt: Date.now(), updatedAt: Date.now(),
        };
        await kv_1.kv.set(activeKey, job.id, 30 * 60_000);
        await save(job);
        running++;
        void runJob(actor, event, plan, sizes, (0, cardDownload_service_1.zipFileNames)(event.title, sess ? sess.name : null, sizes.length), job)
            .catch(() => undefined)
            .finally(() => { running--; void kv_1.kv.del(activeKey).catch(() => undefined); });
        return job;
    },
    /** Progress of a job. Only the person who started it can see it. A job that stopped reporting (the server restarted) is reported as failed. */
    async status(actor, jobId) {
        const job = await load(jobId);
        if (!job || job.userId !== actor.userId)
            throw (0, cardDownload_service_1.fail)(404, 'This download was not found. It may have expired; please start it again.', 'JOB_NOT_FOUND');
        if (job.status === 'RUNNING' && Date.now() - job.updatedAt > STALLED_AFTER_MS) {
            job.status = 'FAILED';
            job.error = 'The preparation was interrupted. Please start the download again.';
        }
        const { filePath, ...safe } = job;
        return safe;
    },
    /** A short-lived link to the finished zip, so the browser (or phone) can download it straight to disk */
    async ticket(actor, eventId, jobId) {
        const job = await load(jobId);
        if (!job || job.userId !== actor.userId || job.eventId !== eventId)
            throw (0, cardDownload_service_1.fail)(404, 'This download was not found. Please start it again.', 'JOB_NOT_FOUND');
        if (job.status !== 'DONE' || !job.filePath || !fs_1.default.existsSync(job.filePath))
            throw (0, cardDownload_service_1.fail)(409, 'The cards are not ready yet.', 'JOB_NOT_READY');
        const token = crypto_1.default.randomBytes(24).toString('hex');
        await kv_1.kv.set(`cj:t:${token}`, job.id, TICKET_MS);
        return { path: `/api/v1/card-files/${token}`, expiresInSeconds: TICKET_MS / 1000 };
    },
    /** The finished file behind a ticket (no sign-in: the unguessable, short-lived ticket is the permission) */
    async fileFor(token) {
        const jobId = /^[0-9a-f]{48}$/.test(token) ? await kv_1.kv.get(`cj:t:${token}`) : null;
        const job = jobId ? await load(jobId) : null;
        if (!job || job.status !== 'DONE' || !job.filePath || !fs_1.default.existsSync(job.filePath))
            throw (0, cardDownload_service_1.fail)(404, 'This download link has expired. Please start the download again.', 'LINK_EXPIRED');
        return { filePath: job.filePath, fileName: job.fileName, size: job.size || fs_1.default.statSync(job.filePath).size };
    },
};
async function runJob(actor, event, plan, sizes, partNames, job) {
    const files = [];
    let lastSaved = 0;
    const progress = async (force = false) => { if (force || Date.now() - lastSaved > 1000) {
        lastSaved = Date.now();
        await save(job);
    } };
    try {
        await sweepOldFiles();
        await fs_1.default.promises.mkdir(DIR, { recursive: true });
        const finalPath = path_1.default.join(DIR, `${job.id}.zip`);
        files.push(finalPath);
        const out = fs_1.default.createWriteStream(finalPath);
        const guestsFor = async (offset, count) => {
            const wanted = plan.inviteeIds.slice(offset, offset + count);
            const order = new Map(wanted.map((id, i) => [String(id), i]));
            return (await Invitee_1.Invitee.find({ eventId: job.eventId, _id: { $in: wanted } }).select('+qrTokenCipher')).sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));
        };
        const tick = () => { job.doneGuests++; void progress(); };
        if (sizes.length === 1) {
            // up to 100 guests: the PDFs are in the one zip directly
            await (0, cardDownload_service_1.writePartZip)(actor, event, await guestsFor(0, sizes[0]), 0, out, tick);
            job.doneParts = 1;
        }
        else {
            // more: one outer zip holding the smaller zips. Each smaller zip is built on disk, added, and removed before the next, so the disk
            // never holds the cards twice.
            const outer = (0, archiver_1.default)('zip', { store: true });
            const outerDone = new Promise((resolve, reject) => { out.on('finish', () => resolve()); out.on('error', reject); outer.on('error', reject); });
            outer.pipe(out);
            let offset = 0;
            for (let part = 0; part < sizes.length; part++) {
                const innerPath = path_1.default.join(DIR, `${job.id}-part${part + 1}.zip`);
                files.push(innerPath);
                await (0, cardDownload_service_1.writePartZip)(actor, event, await guestsFor(offset, sizes[part]), offset, fs_1.default.createWriteStream(innerPath), tick);
                await new Promise((resolve) => { outer.once('entry', () => resolve()); outer.append(fs_1.default.createReadStream(innerPath), { name: partNames[part] }); });
                await fs_1.default.promises.rm(innerPath, { force: true });
                offset += sizes[part];
                job.doneParts = part + 1;
                await progress(true);
            }
            await outer.finalize();
            await outerDone;
        }
        job.status = 'DONE';
        job.filePath = finalPath;
        job.size = (await fs_1.default.promises.stat(finalPath)).size;
        await save(job);
        // the file is kept for a little while so it can be downloaded (and downloaded again), then removed
        setTimeout(() => { void fs_1.default.promises.rm(finalPath, { force: true }); void kv_1.kv.del(jobKey(job.id)).catch(() => undefined); }, FILE_KEEP_MS).unref?.();
    }
    catch (err) {
        console.error('Card job failed:', err?.message);
        job.status = 'FAILED';
        job.error = 'The cards could not be prepared. Please try again.';
        await save(job);
        await Promise.all(files.map((f) => fs_1.default.promises.rm(f, { force: true }).catch(() => undefined)));
    }
}
