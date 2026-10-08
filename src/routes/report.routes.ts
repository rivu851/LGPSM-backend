import { Router } from 'express';
import { reportController } from '../controllers/report.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';

const router = Router();

router.use(authenticate);

// Overall dashboard analytics
router.get('/dashboard', authorizeRoles(Role.ORGANIZER, Role.ADMIN), reportController.getDashboardStats);

// Platform earnings: admins see all events, organizers only their own (billing view)
router.get('/earnings', authorizeRoles(Role.ADMIN, Role.ORGANIZER), reportController.getEarnings);

// Platform home screen overview: revenue, events, monthly trend, top organizers (admin)
router.get('/admin-overview', authorizeRoles(Role.ADMIN), reportController.getAdminOverview);

// Event-specific analytics report
router.get('/events/:eventId', authorizeRoles(Role.ORGANIZER, Role.ADMIN), reportController.getEventReport);

export default router;
