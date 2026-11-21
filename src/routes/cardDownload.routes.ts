import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { auditAction } from '../middlewares/auditAction';
import { Role } from '../models/User';
import { perUserLimit, dedupeWindow } from '../middlewares/userRateLimit';

// printing cards is heavy work: a few plans and a limited number of zips per person per hour
const planLimit = perUserLimit('cards-plan', { windowMs: 10 * 60_000, max: 10, message: 'Too many card downloads started. Please wait a few minutes.' });
const zipLimit = perUserLimit('cards-zip', { windowMs: 60 * 60_000, max: 60, message: 'Too many card zips requested this hour. Please try again later.' });
import { cardDownloadService } from '../services/cardDownload.service';
import { cardJobService } from '../services/cardJob.service';
import fs from 'fs';

const router = Router({ mergeParams: true });
/** Mounted on its own path (not under /events, which requires sign-in): /api/v1/card-files/:ticket */
export const cardFileRoutes = Router();
router.use(authenticate);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);
const planBody = z.object({ inviteeIds: z.array(objectId).min(1, 'Select at least one guest.').max(20000), sessionId: objectId.nullish() });
const partInput = z.object({ planId: objectId, part: z.number().int().min(1) });

const handle = (res: Response, e: any) => {
  if (res.headersSent) { res.destroy(); return; }
  const status = e?.statusCode || 500;
  if (status === 500) console.error('Card download failed:', e?.message);
  res.status(status).json({ success: false, code: e?.code, message: status === 500 ? 'The cards could not be produced. Please try again.' : e.message });
};

// POST /api/v1/events/:eventId/invitation-cards/plan: keeps the selected guests and says how many zip files they make (the system splits
// them evenly, at most 100 guests per zip)
router.post('/plan', authorizeRoles(Role.ORGANIZER, Role.ADMIN), planLimit, async (req: Request, res: Response) => {
  const p = planBody.safeParse(req.body);
  if (!p.success) return res.status(400).json({ success: false, code: 'NO_GUESTS_SELECTED', message: p.error.issues[0]?.message || 'Select at least one guest.' });
  try {
    res.json({ success: true, data: await cardDownloadService.plan((req as any).user, String(req.params.eventId), p.data.inviteeIds, p.data.sessionId) });
  } catch (e) { handle(res, e); }
});

const stream = async (req: Request, res: Response, input: unknown) => {
  const p = partInput.safeParse(input);
  if (!p.success) return res.status(400).json({ success: false, message: 'A plan and a part number are required.' });
  try {
    await cardDownloadService.streamZip((req as any).user, String(req.params.eventId), p.data, res);
  } catch (e) { handle(res, e); }
};
const audit = auditAction({ action: 'INVITATION_CARDS_DOWNLOADED', entityType: 'Event', eventParam: 'eventId', describe: 'Printable invitation cards were downloaded' });

// POST /api/v1/events/:eventId/invitation-cards/download { planId, part }: one zip of printable PDFs, one PDF per guest
router.post('/download', authorizeRoles(Role.ORGANIZER, Role.ADMIN), zipLimit, dedupeWindow('cards-zip', 5_000), audit, (req, res) => stream(req, res, req.body));
// GET .../download?planId=&part=: the same for clients that can only download with GET (the mobile app's system downloader)
router.get('/download', authorizeRoles(Role.ORGANIZER, Role.ADMIN), zipLimit, dedupeWindow('cards-zip', 5_000), audit, (req, res) => stream(req, res, { planId: req.query.planId, part: Number(req.query.part) }));

// POST /jobs { planId }: starts building the cards in the background; answers at once
router.post('/jobs', authorizeRoles(Role.ORGANIZER, Role.ADMIN), perUserLimit('cards-job', { windowMs: 60 * 60_000, max: 12, message: 'Too many card downloads started this hour. Please try again later.' }), audit, async (req: Request, res: Response) => {
  const p = z.object({ planId: objectId }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ success: false, message: 'A plan is required.' });
  try {
    const job = await cardJobService.start((req as any).user, String(req.params.eventId), p.data.planId);
    res.status(202).json({ success: true, data: { jobId: job.id, total: job.total, zips: job.zips, fileName: job.fileName, nested: job.nested } });
  } catch (e: any) {
    if (e?.code === 'JOB_ALREADY_RUNNING') return res.status(409).json({ success: false, code: e.code, jobId: e.jobId, message: e.message });
    handle(res, e);
  }
});

// GET /jobs/:jobId: progress (the page asks every couple of seconds)
router.get('/jobs/:jobId', authorizeRoles(Role.ORGANIZER, Role.ADMIN), perUserLimit('cards-job-status', { windowMs: 60_000, max: 90 }), async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await cardJobService.status((req as any).user, String(req.params.jobId)) }); } catch (e) { handle(res, e); }
});

// POST /jobs/:jobId/ticket: a short-lived link to the finished zip
router.post('/jobs/:jobId/ticket', authorizeRoles(Role.ORGANIZER, Role.ADMIN), perUserLimit('cards-ticket', { windowMs: 60_000, max: 20 }), async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await cardJobService.ticket((req as any).user, String(req.params.eventId), String(req.params.jobId)) }); } catch (e) { handle(res, e); }
});


// The finished zip, behind a short-lived ticket (no sign-in header: a browser or phone downloads it straight to disk). Declared before the
// sign-in check on purpose; the ticket is the permission, and the route is limited per address.
cardFileRoutes.get('/:token', perUserLimit('cards-file', { windowMs: 60_000, max: 30 }), async (req: Request, res: Response) => {
  try {
    const f = await cardJobService.fileFor(String(req.params.token));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(f.size));
    res.setHeader('Content-Disposition', `attachment; filename="${f.fileName.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/"/g, '') || 'cards.zip'}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(f.filePath).on('error', () => res.destroy()).pipe(res);
  } catch (e) { handle(res, e); }
});


export default router;
