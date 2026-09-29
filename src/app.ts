import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler } from './middlewares/errorHandler';

import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import eventRoutes from './routes/event.routes';
import mediaRoutes from './routes/media.routes';
import { eventSessionRoutes, sessionRoutes } from './routes/session.routes';
import { eventInviteeRoutes, inviteeRoutes } from './routes/invitee.routes';
import invitationRoutes from './routes/invitation.routes';
import publicInvitationRoutes from './routes/publicInvitation.routes';
import { eventAssignmentRoutes, assignmentRoutes, myAssignmentRoutes } from './routes/systemUserAssignment.routes';
import checkInRoutes, { eventCheckInRoutes } from './routes/checkIn.routes';
import categoryRoutes from './routes/category.routes';
import templateRoutes from './routes/template.routes';
import notificationRoutes from './routes/notification.routes';
import auditLogRoutes from './routes/auditLog.routes';
import reportRoutes from './routes/report.routes';
import { eventTicketTierRoutes, ticketTierRoutes } from './routes/ticketTier.routes';
import paymentRoutes from './routes/payment.routes';

const app = express();

// Security and Middleware
app.use(helmet());
app.use(cors({
  origin: [
    env.FRONTEND_URL,
    'http://localhost:3000',
    'https://lgpsm-frontend.vercel.app',
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic health-check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Backend is running securely' });
});

// Reject malformed ObjectId path params up-front so they surface as 400s instead of 500 CastErrors
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const requireObjectIdParam = (param: string, allowedLiterals: string[] = []) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const value = req.params[param] as string;
    if (value && !allowedLiterals.includes(value) && !OBJECT_ID_PATTERN.test(value)) {
      res.status(400).json({ success: false, message: `Invalid ${param} format` });
      return;
    }
    next();
  };

app.use('/api/v1/events/:eventId', requireObjectIdParam('eventId'));
app.use('/api/v1/sessions/:sessionId', requireObjectIdParam('sessionId'));
app.use('/api/v1/invitees/:inviteeId', requireObjectIdParam('inviteeId'));
app.use('/api/v1/assignments/:assignmentId', requireObjectIdParam('assignmentId'));
app.use('/api/v1/tickets/:id', requireObjectIdParam('id'));
app.use('/api/v1/reports/events/:eventId', requireObjectIdParam('eventId'));
app.use('/api/v1/notifications/:id', requireObjectIdParam('id', ['read-all', 'clear-all']));
app.use('/api/v1/categories/:id', requireObjectIdParam('id'));
app.use('/api/v1/templates/:id', requireObjectIdParam('id'));
app.use('/api/users/:id', requireObjectIdParam('id', ['profile', 'me']));
app.use('/api/v1/orders/:id', requireObjectIdParam('id'));
app.use('/api/v1/invoices/:id', requireObjectIdParam('id'));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/media', mediaRoutes);
app.use('/api/v1/events/:eventId/sessions', eventSessionRoutes);
app.use('/api/v1/sessions', sessionRoutes);
app.use('/api/v1/events/:eventId/invitees', eventInviteeRoutes);
app.use('/api/v1/invitees', inviteeRoutes);
app.use('/api/v1/events/:eventId/assignments', eventAssignmentRoutes);
app.use('/api/v1/events/:eventId/invitations', invitationRoutes);
app.use('/api/v1/public/invitations', publicInvitationRoutes);
app.use('/api/v1/assignments', assignmentRoutes);
app.use('/api/v1/users/me/assignments', myAssignmentRoutes);
app.use('/api/v1/checkins', checkInRoutes);
app.use('/api/v1/events/:eventId/checkins', eventCheckInRoutes);

// Category, Template, Notification, AuditLog, Report, Ticketing & Payment Routes
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/templates', templateRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/audit-logs', auditLogRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/events/:eventId/tickets', eventTicketTierRoutes);
app.use('/api/v1/tickets', ticketTierRoutes);
app.use('/api/v1', paymentRoutes);

// Global error handler should be the last middleware
app.use(errorHandler);

export default app;
