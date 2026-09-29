"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const env_1 = require("./config/env");
const errorHandler_1 = require("./middlewares/errorHandler");
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const user_routes_1 = __importDefault(require("./routes/user.routes"));
const event_routes_1 = __importDefault(require("./routes/event.routes"));
const media_routes_1 = __importDefault(require("./routes/media.routes"));
const session_routes_1 = require("./routes/session.routes");
const invitee_routes_1 = require("./routes/invitee.routes");
const invitation_routes_1 = __importDefault(require("./routes/invitation.routes"));
const publicInvitation_routes_1 = __importDefault(require("./routes/publicInvitation.routes"));
const systemUserAssignment_routes_1 = require("./routes/systemUserAssignment.routes");
const checkIn_routes_1 = __importStar(require("./routes/checkIn.routes"));
const category_routes_1 = __importDefault(require("./routes/category.routes"));
const template_routes_1 = __importDefault(require("./routes/template.routes"));
const notification_routes_1 = __importDefault(require("./routes/notification.routes"));
const auditLog_routes_1 = __importDefault(require("./routes/auditLog.routes"));
const report_routes_1 = __importDefault(require("./routes/report.routes"));
const ticketTier_routes_1 = require("./routes/ticketTier.routes");
const payment_routes_1 = __importDefault(require("./routes/payment.routes"));
const app = (0, express_1.default)();
// Security and Middleware
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({
    origin: [
        env_1.env.FRONTEND_URL,
        'http://localhost:3000',
        'https://lgpsm-frontend.vercel.app',
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
}));
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// Basic health-check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Backend is running securely' });
});
// Reject malformed ObjectId path params up-front so they surface as 400s instead of 500 CastErrors
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const requireObjectIdParam = (param, allowedLiterals = []) => (req, res, next) => {
    const value = req.params[param];
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
app.use('/api/auth', auth_routes_1.default);
app.use('/api/users', user_routes_1.default);
app.use('/api/v1/events', event_routes_1.default);
app.use('/api/v1/media', media_routes_1.default);
app.use('/api/v1/events/:eventId/sessions', session_routes_1.eventSessionRoutes);
app.use('/api/v1/sessions', session_routes_1.sessionRoutes);
app.use('/api/v1/events/:eventId/invitees', invitee_routes_1.eventInviteeRoutes);
app.use('/api/v1/invitees', invitee_routes_1.inviteeRoutes);
app.use('/api/v1/events/:eventId/assignments', systemUserAssignment_routes_1.eventAssignmentRoutes);
app.use('/api/v1/events/:eventId/invitations', invitation_routes_1.default);
app.use('/api/v1/public/invitations', publicInvitation_routes_1.default);
app.use('/api/v1/assignments', systemUserAssignment_routes_1.assignmentRoutes);
app.use('/api/v1/users/me/assignments', systemUserAssignment_routes_1.myAssignmentRoutes);
app.use('/api/v1/checkins', checkIn_routes_1.default);
app.use('/api/v1/events/:eventId/checkins', checkIn_routes_1.eventCheckInRoutes);
// Category, Template, Notification, AuditLog, Report, Ticketing & Payment Routes
app.use('/api/v1/categories', category_routes_1.default);
app.use('/api/v1/templates', template_routes_1.default);
app.use('/api/v1/notifications', notification_routes_1.default);
app.use('/api/v1/audit-logs', auditLog_routes_1.default);
app.use('/api/v1/reports', report_routes_1.default);
app.use('/api/v1/events/:eventId/tickets', ticketTier_routes_1.eventTicketTierRoutes);
app.use('/api/v1/tickets', ticketTier_routes_1.ticketTierRoutes);
app.use('/api/v1', payment_routes_1.default);
// Global error handler should be the last middleware
app.use(errorHandler_1.errorHandler);
exports.default = app;
