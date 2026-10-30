import { requestId } from './middlewares/requestId';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';

import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import eventRoutes from './routes/event.routes';
import mediaRoutes from './routes/media.routes';
import { eventSessionRoutes, sessionRoutes } from './routes/session.routes';
import { eventInviteeRoutes, inviteeRoutes } from './routes/invitee.routes';
import invitationRoutes from './routes/invitation.routes';
import publicInvitationRoutes from './routes/publicInvitation.routes';
import contactRoutes from './routes/contact.routes';
import { eventAssignmentRoutes, assignmentRoutes, myAssignmentRoutes } from './routes/systemUserAssignment.routes';
import checkInRoutes, { eventCheckInRoutes } from './routes/checkIn.routes';
import categoryRoutes from './routes/category.routes';
import templateRoutes from './routes/template.routes';
import templateGenerationRoutes from './routes/templateGeneration.routes';
import notificationRoutes from './routes/notification.routes';
import auditLogRoutes from './routes/auditLog.routes';
import reportRoutes from './routes/report.routes';
import { eventTicketTierRoutes, ticketTierRoutes } from './routes/ticketTier.routes';
import paymentRoutes from './routes/payment.routes';
import platformSettingsRoutes from './routes/platformSettings.routes';

const app = express();

// Render forwards requests through one trusted proxy.
app.set('trust proxy', 1);

// Security and Middleware
app.use(helmet());
app.use(requestId);
// Per-request logging (method, path, status, response time). Silenced during
// the test suite so Jest output stays readable.
if (env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}
// Browsers send the origin without a trailing slash, so entries are normalised before matching
const allowedOrigins = [
  env.FRONTEND_URL,
  'http://localhost:3000',
  'https://lgpsm-frontend.vercel.app',
  'https://lgpsm-frontend-beta.vercel.app',
  ...(env.CORS_ORIGINS?.split(',') ?? []),
]
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  exposedHeaders: ['X-Invitation-Qr'],
  credentials: true,
}));
// The raw bytes are kept so webhook signatures can be verified against exactly what the sender signed
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf;
  }
}));
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
app.use('/api/v1/templates/:id', requireObjectIdParam('id', ['defaults', 'preview']));
app.use('/api/users/:id', requireObjectIdParam('id', ['profile', 'me']));
app.use('/api/v1/orders/:id', requireObjectIdParam('id'));
app.use('/api/v1/invoices/:id', requireObjectIdParam('id'));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/media/:id', requireObjectIdParam('id', ['presign', 'upload']));
app.use('/api/v1/media', mediaRoutes);
app.use('/api/v1/events/:eventId/sessions', eventSessionRoutes);
app.use('/api/v1/sessions', sessionRoutes);
app.use('/api/v1/events/:eventId/invitees', eventInviteeRoutes);
app.use('/api/v1/invitees', inviteeRoutes);
app.use('/api/v1/events/:eventId/assignments', eventAssignmentRoutes);
app.use('/api/v1/events/:eventId/invitations', invitationRoutes);
app.use('/api/v1/public/invitations', publicInvitationRoutes);
app.use('/api/v1/public/contact', contactRoutes);
app.use('/api/v1/assignments', assignmentRoutes);
app.use('/api/v1/users/me/assignments', myAssignmentRoutes);
app.use('/api/v1/checkins', checkInRoutes);
app.use('/api/v1/events/:eventId/checkins', eventCheckInRoutes);

// Category, Template, Notification, AuditLog, Report, Ticketing & Payment Routes
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/template-generations/:id', requireObjectIdParam('id', ['options', 'from-template']));
app.use('/api/v1/template-generations/from-template/:templateId', requireObjectIdParam('templateId'));
app.use('/api/v1/template-generations', templateGenerationRoutes);
app.use('/api/v1/templates', templateRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/audit-logs', auditLogRoutes);
app.use('/api/v1/settings', platformSettingsRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/events/:eventId/tickets', eventTicketTierRoutes);
app.use('/api/v1/tickets', ticketTierRoutes);
app.use('/api/v1', paymentRoutes);

// Keep unmatched API requests in the same JSON error format as other failures.
app.use(notFoundHandler);

// Global error handler should be the last middleware
app.use(errorHandler);

export default app;
