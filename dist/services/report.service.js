"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportService = void 0;
const sessionAccess_1 = require("../utils/sessionAccess");
const invitationContent_1 = require("../utils/invitationContent");
const mongoose_1 = __importDefault(require("mongoose"));
const platformSettings_service_1 = require("./platformSettings.service");
const PlatformSettings_1 = require("../models/PlatformSettings");
const Event_1 = require("../models/Event");
const Invitee_1 = require("../models/Invitee");
const CheckIn_1 = require("../models/CheckIn");
const Session_1 = require("../models/Session");
const SystemUserAssignment_1 = require("../models/SystemUserAssignment");
exports.reportService = {
    async getDashboardStats(user) {
        const isOrganizer = user.role !== 'ADMIN';
        const eventQuery = isOrganizer ? { organizerId: new mongoose_1.default.Types.ObjectId(user.userId) } : {};
        const totalEvents = await Event_1.Event.countDocuments(eventQuery);
        // Get all matching event IDs
        const events = await Event_1.Event.find(eventQuery, '_id');
        const eventIds = events.map(e => e._id);
        const totalInvitees = await Invitee_1.Invitee.countDocuments({ eventId: { $in: eventIds } });
        const totalCheckIns = await CheckIn_1.CheckIn.countDocuments({ eventId: { $in: eventIds } });
        const rsvpStats = await Invitee_1.Invitee.aggregate([
            { $match: { eventId: { $in: eventIds } } },
            { $group: { _id: '$rsvpStatus', count: { $sum: 1 } } }
        ]);
        const rsvpSummary = {
            ACCEPTED: 0,
            DECLINED: 0,
            PENDING: 0
        };
        rsvpStats.forEach((stat) => {
            if (stat._id in rsvpSummary) {
                rsvpSummary[stat._id] = stat.count;
            }
        });
        return {
            totalEvents,
            totalInvitees,
            totalCheckIns,
            rsvpSummary
        };
    },
    async getEventReport(eventId, user) {
        const isOrganizer = user.role !== 'ADMIN';
        const eventQuery = { _id: eventId };
        if (isOrganizer) {
            eventQuery.organizerId = user.userId;
        }
        const event = await Event_1.Event.findOne(eventQuery);
        if (!event)
            throw new Error('EVENT_NOT_FOUND');
        const eventObjId = new mongoose_1.default.Types.ObjectId(eventId);
        const totalInvitees = await Invitee_1.Invitee.countDocuments({ eventId: eventObjId });
        const totalCheckIns = await CheckIn_1.CheckIn.countDocuments({ eventId: eventObjId });
        // RSVP breakdown
        const rsvpStats = await Invitee_1.Invitee.aggregate([
            { $match: { eventId: eventObjId } },
            { $group: { _id: '$rsvpStatus', count: { $sum: 1 } } }
        ]);
        const rsvpSummary = { ACCEPTED: 0, DECLINED: 0, PENDING: 0 };
        rsvpStats.forEach((stat) => {
            if (stat._id in rsvpSummary) {
                rsvpSummary[stat._id] = stat.count;
            }
        });
        // Invitation Delivery Status breakdown
        const deliveryStats = await Invitee_1.Invitee.aggregate([
            { $match: { eventId: eventObjId } },
            { $group: { _id: '$invitationStatus', count: { $sum: 1 } } }
        ]);
        const deliverySummary = { SENT: 0, PENDING: 0, FAILED: 0 };
        deliveryStats.forEach((stat) => {
            if (stat._id in deliverySummary) {
                deliverySummary[stat._id] = stat.count;
            }
        });
        // Check-in Method breakdown (QR vs MANUAL)
        const methodStats = await CheckIn_1.CheckIn.aggregate([
            { $match: { eventId: eventObjId } },
            { $group: { _id: '$checkInMethod', count: { $sum: 1 } } }
        ]);
        const checkInMethods = { QR: 0, MANUAL: 0 };
        methodStats.forEach((stat) => {
            if (stat._id in checkInMethods) {
                checkInMethods[stat._id] = stat.count;
            }
        });
        // Distinct attendees (an invitee checked into several sessions counts once)
        const attendeeIds = await CheckIn_1.CheckIn.distinct('inviteeId', { eventId: eventObjId });
        const uniqueAttendees = attendeeIds.length;
        // System users assigned to this event
        const assignments = await SystemUserAssignment_1.SystemUserAssignment.find({ eventId: eventObjId }, 'sessionIds').lean();
        const totalSystemUsers = assignments.length;
        // Sessions breakdown
        const sessions = await Session_1.Session.find({ eventId: eventObjId }).sort({ 'schedule.start': 1 });
        const todayStart = (0, invitationContent_1.startOfTodayInAppZone)();
        const sessionReports = await Promise.all(sessions.map(async (sess) => {
            const [count, sessionAttendees, invitedCount, checkInsToday] = await Promise.all([
                CheckIn_1.CheckIn.countDocuments({ eventId: eventObjId, sessionId: sess._id }),
                CheckIn_1.CheckIn.distinct('inviteeId', { eventId: eventObjId, sessionId: sess._id }),
                // Invitees with no explicit session rules may attend every session
                Invitee_1.Invitee.countDocuments({ eventId: eventObjId, ...(0, sessionAccess_1.inviteesAllowedFilter)(sess) }),
                CheckIn_1.CheckIn.countDocuments({ eventId: eventObjId, sessionId: sess._id, checkInAt: { $gte: todayStart } })
            ]);
            // Staff with no session restriction cover every session
            const systemUsers = assignments.filter((a) => !a.sessionIds || a.sessionIds.length === 0 || a.sessionIds.some((id) => id.toString() === sess._id.toString())).length;
            return {
                sessionId: sess._id,
                name: sess.name,
                checkInCount: count,
                attendeeCount: sessionAttendees.length,
                invitedCount,
                checkInsToday,
                systemUsers,
                accessControl: sess.accessControl,
                schedule: sess.schedule
            };
        }));
        const attendanceRate = totalInvitees > 0 ? ((uniqueAttendees / totalInvitees) * 100).toFixed(2) + '%' : '0.00%';
        return {
            event: {
                id: event._id,
                title: event.title,
                schedule: event.schedule,
                format: event.format
            },
            attendanceRate,
            totalInvitees,
            totalCheckIns,
            uniqueAttendees,
            totalSessions: sessions.length,
            totalSystemUsers,
            rsvpSummary,
            deliverySummary,
            checkInMethods,
            sessionReports
        };
    },
    // Platform earnings per event: invitations sent x the event's locked per-invitee rate.
    // Events created before rates were locked use the rate that was in effect when they were created.
    async getEarnings(filter = {}) {
        const query = { status: { $ne: 'CANCELLED' } };
        if (filter.from || filter.to) {
            query['schedule.start'] = {};
            if (filter.from)
                query['schedule.start'].$gte = filter.from;
            if (filter.to)
                query['schedule.start'].$lte = filter.to;
        }
        if (filter.eventId) {
            query._id = filter.eventId;
        }
        if (filter.organizerId) {
            query.organizerId = filter.organizerId;
        }
        const events = await Event_1.Event.find(query)
            .select('title schedule createdAt organizerId pricing status')
            .populate('organizerId', 'fullName email phone profile')
            .sort({ 'schedule.start': -1 })
            .lean();
        const sentCounts = await Invitee_1.Invitee.aggregate([
            { $match: { eventId: { $in: events.map((e) => e._id) }, invitationStatus: Invitee_1.InvitationStatus.SENT } },
            { $group: { _id: '$eventId', count: { $sum: 1 } } }
        ]);
        const sentByEvent = new Map(sentCounts.map((c) => [String(c._id), c.count]));
        const settings = await PlatformSettings_1.PlatformSettings.findOne({ key: 'global' }).lean();
        const currency = settings?.pricing?.currency || 'USD';
        const rows = await Promise.all(events.map(async (e) => {
            const locked = e.pricing && e.pricing.lockedAt;
            const rate = locked ? e.pricing.ratePerInvitee ?? null : await platformSettings_service_1.platformSettingsService.rateInEffectAt(new Date(e.createdAt));
            const invites = sentByEvent.get(String(e._id)) || 0;
            const org = e.organizerId || {};
            return {
                eventId: String(e._id),
                eventName: e.title,
                organizerId: org._id ? String(org._id) : null,
                organizerName: org.profile?.organizationName || org.fullName || '',
                organizerEmail: org.email || '',
                organizerPhone: org.phone || '',
                eventStart: e.schedule?.start,
                createdAt: e.createdAt,
                invitesSent: invites,
                ratePerInvitee: rate,
                rateSource: locked ? 'locked' : rate === null ? 'unset' : 'historical',
                amount: rate === null ? null : Math.round(invites * rate * 100) / 100
            };
        }));
        return {
            currency,
            currentRate: settings?.pricing?.ratePerInvitee ?? null,
            totalAmount: Math.round(rows.reduce((sum, r) => sum + (r.amount || 0), 0) * 100) / 100,
            totalInvitesSent: rows.reduce((sum, r) => sum + r.invitesSent, 0),
            eventsWithoutRate: rows.filter((r) => r.ratePerInvitee === null).length,
            events: rows
        };
    },
    // Platform home screen for ADMIN: total revenue/events, a monthly revenue series for the
    // selected range, and the organizers generating the most revenue in that range.
    async getAdminOverview(filter = {}) {
        const earnings = await this.getEarnings(filter);
        const monthBuckets = new Map();
        const organizerTotals = new Map();
        for (const row of earnings.events) {
            if (!row.eventStart || row.amount === null)
                continue;
            const date = new Date(row.eventStart);
            const key = `${date.getFullYear()}-${date.getMonth()}`;
            const label = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();
            const bucket = monthBuckets.get(key) || { label, year: date.getFullYear(), month: date.getMonth(), amount: 0 };
            bucket.amount += row.amount;
            monthBuckets.set(key, bucket);
            if (row.organizerId) {
                const org = organizerTotals.get(row.organizerId) || {
                    organizerId: row.organizerId,
                    name: row.organizerName,
                    email: row.organizerEmail,
                    phone: row.organizerPhone,
                    amount: 0
                };
                org.amount += row.amount;
                organizerTotals.set(row.organizerId, org);
            }
        }
        const revenueByMonth = Array.from(monthBuckets.values())
            .sort((a, b) => a.year - b.year || a.month - b.month)
            .map(({ label, amount }) => ({ label, amount: Math.round(amount * 100) / 100 }));
        const topOrganizers = Array.from(organizerTotals.values())
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 5)
            .map((o) => ({ ...o, amount: Math.round(o.amount * 100) / 100 }));
        return {
            currency: earnings.currency,
            totalRevenue: earnings.totalAmount,
            totalEvents: earnings.events.length,
            revenueByMonth,
            topOrganizers
        };
    }
};
