import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { auditAction } from '../middlewares/auditAction';
import { Role } from '../models/User';
import { cardDownloadService, MAX_PER_ZIP } from '../services/cardDownload.service';

const router = Router({ mergeParams: true });
router.use(authenticate);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);
const body = z.object({
  perZip: z.number().int().min(1).max(MAX_PER_ZIP),
  part: z.number().int().min(1).optional(),
  inviteeIds: z.array(objectId).max(20000).optional()
});

const handle = (res: Response, e: any) => {
  if (res.headersSent) { res.destroy(); return; }
  const status = e?.statusCode || 500;
  if (status === 500) console.error('Card download failed:', e?.message);
  res.status(status).json({ success: false, code: e?.code, message: status === 500 ? 'The cards could not be produced. Please try again.' : e.message });
};

// POST /api/v1/events/:eventId/invitation-cards/plan: how many guests and how many zip files
router.post('/plan', authorizeRoles(Role.ORGANIZER, Role.ADMIN), async (req: Request, res: Response) => {
  const p = body.safeParse(req.body);
  if (!p.success) return res.status(400).json({ success: false, message: `Guests per zip must be a whole number from 1 to ${MAX_PER_ZIP}.` });
  try {
    res.json({ success: true, data: await cardDownloadService.plan((req as any).user, String(req.params.eventId), p.data.perZip, p.data.inviteeIds) });
  } catch (e) { handle(res, e); }
});

// POST /api/v1/events/:eventId/invitation-cards/download: one zip (part n) of printable PDFs, one PDF per guest
router.post('/download', authorizeRoles(Role.ORGANIZER, Role.ADMIN),
  auditAction({ action: 'INVITATION_CARDS_DOWNLOADED', entityType: 'Event', eventParam: 'eventId', describe: 'Printable invitation cards were downloaded' }),
  async (req: Request, res: Response) => {
    const p = body.safeParse(req.body);
    if (!p.success) return res.status(400).json({ success: false, message: `Guests per zip must be a whole number from 1 to ${MAX_PER_ZIP}.` });
    try {
      await cardDownloadService.streamZip((req as any).user, String(req.params.eventId), { part: p.data.part ?? 1, perZip: p.data.perZip, inviteeIds: p.data.inviteeIds }, res);
    } catch (e) { handle(res, e); }
  });

// GET /api/v1/events/:eventId/invitation-cards/download?perZip=&part=&inviteeIds=a,b: the same zip for clients that can only download with GET
// (the mobile app saves files through the system downloader)
router.get('/download', authorizeRoles(Role.ORGANIZER, Role.ADMIN),
  auditAction({ action: 'INVITATION_CARDS_DOWNLOADED', entityType: 'Event', eventParam: 'eventId', describe: 'Printable invitation cards were downloaded' }),
  async (req: Request, res: Response) => {
    const ids = typeof req.query.inviteeIds === 'string' && req.query.inviteeIds ? req.query.inviteeIds.split(',') : undefined;
    const p = body.safeParse({ perZip: Number(req.query.perZip), part: req.query.part ? Number(req.query.part) : undefined, inviteeIds: ids });
    if (!p.success) return res.status(400).json({ success: false, message: `Guests per zip must be a whole number from 1 to ${MAX_PER_ZIP}.` });
    try {
      await cardDownloadService.streamZip((req as any).user, String(req.params.eventId), { part: p.data.part ?? 1, perZip: p.data.perZip, inviteeIds: p.data.inviteeIds }, res);
    } catch (e) { handle(res, e); }
  });

export default router;
