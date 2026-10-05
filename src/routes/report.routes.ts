import { Router } from 'express';
import { reportController } from '../controllers/report.controller';
import { authenticate } from '../middlewares/authenticate';
import { authorizeRoles } from '../middlewares/authorizeRoles';
import { Role } from '../models/User';

const router = Router();

router.use(authenticate);

// Overall dashboard analytics
router.get('/dashboard', authorizeRoles(Role.ORGANIZER, Role.ADMIN), reportController.getDashboardStats);

// Platform earnings (admin)
router.get('/earnings', authorizeRoles(Role.ADMIN), reportController.getEarnings);

// Event-specific analytics report
router.get('/events/:eventId', authorizeRoles(Role.ORGANIZER, Role.ADMIN), reportController.getEventReport);

export default router;
