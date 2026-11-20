import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { auditAction } from '../middlewares/auditAction';
import { Role } from '../models/User';
import { cardDownloadService } from '../services/cardDownload.service';

const router = Router({ mergeParams: true });
router.use(authenticate);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);
const planBody = z.object({ inviteeIds: z.array(objectId).min(1, 'Select at least one guest.').max(20000) });
const partInput = z.object({ planId: objectId, part: z.number().int().min(1) });

const handle = (res: Response, e: any) => {
  if (res.headersSent) { res.destroy(); return; }
  const status = e?.statusCode || 500;
  if (status === 500) console.error('Card download failed:', e?.message);
  res.status(status).json({ success: false, code: e?.code, message: status === 500 ? 'The cards could not be produced. Please try again.' : e.message });
};

// POST /api/v1/events/:eventId/invitation-cards/plan: keeps the selected guests and says how many zip files they make (the system splits
// them evenly, at most 100 guests per zip)
router.post('/plan', authorizeRoles(Role.ORGANIZER, Role.ADMIN), async (req: Request, res: Response) => {
  const p = planBody.safeParse(req.body);
  if (!p.success) return res.status(400).json({ success: false, code: 'NO_GUESTS_SELECTED', message: p.error.issues[0]?.message || 'Select at least one guest.' });
  try {
    res.json({ success: true, data: await cardDownloadService.plan((req as any).user, String(req.params.eventId), p.data.inviteeIds) });
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
router.post('/download', authorizeRoles(Role.ORGANIZER, Role.ADMIN), audit, (req, res) => stream(req, res, req.body));
// GET .../download?planId=&part=: the same for clients that can only download with GET (the mobile app's system downloader)
router.get('/download', authorizeRoles(Role.ORGANIZER, Role.ADMIN), audit, (req, res) => stream(req, res, { planId: req.query.planId, part: Number(req.query.part) }));

export default router;
