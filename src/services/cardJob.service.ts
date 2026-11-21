import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import mongoose from 'mongoose';
import archiver from 'archiver';
import { kv } from '../infra/kv';
import { Invitee } from '../models/Invitee';
import { Session } from '../models/Session';
import { CardDownloadPlan } from '../models/CardDownloadPlan';
import { loadEvent, fail, writePartZip, zipSizes, zipFileNames, type Actor } from './cardDownload.service';

/**
 * Printable cards as ONE download. The cards are built in the background (so no web request runs for minutes, which a shared host would cut
 * off), the person watches the progress, and when it is ready they download a single zip. For more than 100 guests that zip holds the
 * smaller zips (at most 100 guests each); up to 100 guests it holds the PDFs directly.
 *
 * Jobs live in this server process (the key-value store keeps their status, the file sits on this server's disk), which fits one server.
 * A restart loses a running job; the person is told and starts again. Finished files are removed after 30 minutes.
 */
const DIR = process.env.CARD_TMP_DIR || path.join(os.tmpdir(), 'eqr-cards');
const STATUS_TTL_MS = 2 * 60 * 60_000;
const FILE_KEEP_MS = 30 * 60_000;
const STALLED_AFTER_MS = 90_000;
const TICKET_MS = 5 * 60_000;
const maxRunning = () => Math.max(1, Math.floor(Number(process.env.CARD_JOBS_MAX)) || 2);

export interface CardJob {
  id: string; userId: string; eventId: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  total: number; zips: number; doneGuests: number; doneParts: number;
  fileName: string; nested: boolean; size?: number; filePath?: string;
  error?: string; startedAt: number; updatedAt: number;
}

let running = 0;
const jobKey = (id: string) => `cj:${id}`;
async function save(job: CardJob) { job.updatedAt = Date.now(); await kv.set(jobKey(job.id), JSON.stringify(job), STATUS_TTL_MS).catch(() => undefined); }
async function load(id: string): Promise<CardJob | null> { const t = await kv.get(jobKey(id)); return t ? (JSON.parse(t) as CardJob) : null; }

/** Files left behind by an earlier run of the server (a restart mid-job) are removed the first time a job is started */
let swept = false;
async function sweepOldFiles() {
  if (swept) return; swept = true;
  try {
    for (const f of await fs.promises.readdir(DIR)) {
      const p = path.join(DIR, f);
      const st = await fs.promises.stat(p);
      if (Date.now() - st.mtimeMs > STATUS_TTL_MS) await fs.promises.rm(p, { force: true });
    }
  } catch { /* the folder does not exist yet */ }
}

export const cardJobService = {
  /** Starts building the cards for a plan. Returns at once; the work goes on in the background. */
  async start(actor: Actor, eventId: string, planId: string): Promise<CardJob> {
    const event = await loadEvent(actor, eventId);
    const plan: any = mongoose.Types.ObjectId.isValid(planId) ? await CardDownloadPlan.findOne({ _id: planId, eventId, userId: actor.userId }).lean() : null;
    if (!plan) throw fail(404, 'This download has expired. Please start it again.', 'PLAN_EXPIRED');

    // one at a time per person (a second tap attaches to the first), and a few at a time on the whole server
    const activeKey = `cj:active:${actor.userId}`;
    const existingId = await kv.get(activeKey);
    if (existingId) {
      const existing = await load(existingId);
      if (existing && existing.status === 'RUNNING' && Date.now() - existing.updatedAt < STALLED_AFTER_MS) {
        throw Object.assign(fail(409, 'Your cards are already being prepared.', 'JOB_ALREADY_RUNNING'), { jobId: existing.id });
      }
    }
    if (running >= maxRunning()) throw fail(429, 'We are preparing cards for other people right now. Please try again in a minute.', 'SERVER_BUSY');

    const sizes = zipSizes(plan.inviteeIds.length);
    const sess: any = plan.sessionId ? await Session.findOne({ _id: plan.sessionId, eventId }).select('name').lean() : null;
    const job: CardJob = {
      id: crypto.randomBytes(12).toString('hex'), userId: actor.userId, eventId, status: 'RUNNING',
      total: plan.inviteeIds.length, zips: sizes.length, doneGuests: 0, doneParts: 0,
      fileName: zipFileNames(event.title, sess ? sess.name : null, 1)[0], nested: sizes.length > 1,
      startedAt: Date.now(), updatedAt: Date.now(),
    };
    await kv.set(activeKey, job.id, 30 * 60_000);
    await save(job);
    running++;
    void runJob(actor, event, plan, sizes, zipFileNames(event.title, sess ? sess.name : null, sizes.length), job)
      .catch(() => undefined)
      .finally(() => { running--; void kv.del(activeKey).catch(() => undefined); });
    return job;
  },

  /** Progress of a job. Only the person who started it can see it. A job that stopped reporting (the server restarted) is reported as failed. */
  async status(actor: Actor, jobId: string): Promise<CardJob> {
    const job = await load(jobId);
    if (!job || job.userId !== actor.userId) throw fail(404, 'This download was not found. It may have expired; please start it again.', 'JOB_NOT_FOUND');
    if (job.status === 'RUNNING' && Date.now() - job.updatedAt > STALLED_AFTER_MS) {
      job.status = 'FAILED'; job.error = 'The preparation was interrupted. Please start the download again.';
    }
    const { filePath, ...safe } = job;
    return safe as CardJob;
  },

  /** A short-lived link to the finished zip, so the browser (or phone) can download it straight to disk */
  async ticket(actor: Actor, eventId: string, jobId: string): Promise<{ path: string; expiresInSeconds: number }> {
    const job = await load(jobId);
    if (!job || job.userId !== actor.userId || job.eventId !== eventId) throw fail(404, 'This download was not found. Please start it again.', 'JOB_NOT_FOUND');
    if (job.status !== 'DONE' || !job.filePath || !fs.existsSync(job.filePath)) throw fail(409, 'The cards are not ready yet.', 'JOB_NOT_READY');
    const token = crypto.randomBytes(24).toString('hex');
    await kv.set(`cj:t:${token}`, job.id, TICKET_MS);
    return { path: `/api/v1/card-files/${token}`, expiresInSeconds: TICKET_MS / 1000 };
  },

  /** The finished file behind a ticket (no sign-in: the unguessable, short-lived ticket is the permission) */
  async fileFor(token: string): Promise<{ filePath: string; fileName: string; size: number }> {
    const jobId = /^[0-9a-f]{48}$/.test(token) ? await kv.get(`cj:t:${token}`) : null;
    const job = jobId ? await load(jobId) : null;
    if (!job || job.status !== 'DONE' || !job.filePath || !fs.existsSync(job.filePath)) throw fail(404, 'This download link has expired. Please start the download again.', 'LINK_EXPIRED');
    return { filePath: job.filePath, fileName: job.fileName, size: job.size || fs.statSync(job.filePath).size };
  },
};

async function runJob(actor: Actor, event: any, plan: any, sizes: number[], partNames: string[], job: CardJob): Promise<void> {
  const files: string[] = [];
  let lastSaved = 0;
  const progress = async (force = false) => { if (force || Date.now() - lastSaved > 1000) { lastSaved = Date.now(); await save(job); } };
  try {
    await sweepOldFiles();
    await fs.promises.mkdir(DIR, { recursive: true });
    const finalPath = path.join(DIR, `${job.id}.zip`);
    files.push(finalPath);
    const out = fs.createWriteStream(finalPath);
    const guestsFor = async (offset: number, count: number) => {
      const wanted = plan.inviteeIds.slice(offset, offset + count);
      const order = new Map<string, number>(wanted.map((id: any, i: number) => [String(id), i]));
      return (await Invitee.find({ eventId: job.eventId, _id: { $in: wanted } }).select('+qrTokenCipher')).sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));
    };
    const tick = () => { job.doneGuests++; void progress(); };

    if (sizes.length === 1) {
      // up to 100 guests: the PDFs are in the one zip directly
      await writePartZip(actor, event, await guestsFor(0, sizes[0]), 0, out, tick);
      job.doneParts = 1;
    } else {
      // more: one outer zip holding the smaller zips. Each smaller zip is built on disk, added, and removed before the next, so the disk
      // never holds the cards twice.
      const outer = archiver('zip', { store: true });
      const outerDone = new Promise<void>((resolve, reject) => { out.on('finish', () => resolve()); out.on('error', reject); outer.on('error', reject); });
      outer.pipe(out);
      let offset = 0;
      for (let part = 0; part < sizes.length; part++) {
        const innerPath = path.join(DIR, `${job.id}-part${part + 1}.zip`);
        files.push(innerPath);
        await writePartZip(actor, event, await guestsFor(offset, sizes[part]), offset, fs.createWriteStream(innerPath), tick);
        await new Promise<void>((resolve) => { outer.once('entry', () => resolve()); outer.append(fs.createReadStream(innerPath), { name: partNames[part] }); });
        await fs.promises.rm(innerPath, { force: true });
        offset += sizes[part];
        job.doneParts = part + 1;
        await progress(true);
      }
      await outer.finalize();
      await outerDone;
    }
    job.status = 'DONE';
    job.filePath = finalPath;
    job.size = (await fs.promises.stat(finalPath)).size;
    await save(job);
    // the file is kept for a little while so it can be downloaded (and downloaded again), then removed
    setTimeout(() => { void fs.promises.rm(finalPath, { force: true }); void kv.del(jobKey(job.id)).catch(() => undefined); }, FILE_KEEP_MS).unref?.();
  } catch (err: any) {
    console.error('Card job failed:', err?.message);
    job.status = 'FAILED';
    job.error = 'The cards could not be prepared. Please try again.';
    await save(job);
    await Promise.all(files.map((f) => fs.promises.rm(f, { force: true }).catch(() => undefined)));
  }
}
