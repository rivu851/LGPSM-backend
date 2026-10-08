import { inviteesAllowedFilter } from '../utils/sessionAccess';
import { startOfTodayInAppZone } from '../utils/invitationContent';
import mongoose from 'mongoose';
import { platformSettingsService } from './platformSettings.service';
import { PlatformSettings } from '../models/PlatformSettings';
import { Event } from '../models/Event';
import { Invitee, RsvpStatus, InvitationStatus } from '../models/Invitee';
import { CheckIn } from '../models/CheckIn';
import { Session } from '../models/Session';
import { SystemUserAssignment } from '../models/SystemUserAssignment';

export const reportService = {
  async getDashboardStats(user: { userId: string; role: string }) {
    const isOrganizer = user.role !== 'ADMIN';
    const eventQuery: any = isOrganizer ? { organizerId: new mongoose.Types.ObjectId(user.userId) } : {};

    const totalEvents = await Event.countDocuments(eventQuery);
    
    // Get all matching event IDs
    const events = await Event.find(eventQuery, '_id');
    const eventIds = events.map(e => e._id);

    const totalInvitees = await Invitee.countDocuments({ eventId: { $in: eventIds } });
    const totalCheckIns = await CheckIn.countDocuments({ eventId: { $in: eventIds }});

    const rsvpStats = await Invitee.aggregate([
      { $match: { eventId: { $in: eventIds } } },
      { $group: { _id: '$rsvpStatus', count: { $sum: 1 } } }
    ]);

    const rsvpSummary = {
      ACCEPTED: 0,
      DECLINED: 0,
      PENDING: 0
    };

    rsvpStats.forEach((stat: any) => {
      if (stat._id in rsvpSummary) {
        (rsvpSummary as any)[stat._id] = stat.count;
      }
    });

    return {
      totalEvents,
      totalInvitees,
      totalCheckIns,
      rsvpSummary
    };
  },

  async getEventReport(eventId: string, user: { userId: string; role: string }) {
    const isOrganizer = user.role !== 'ADMIN';
    const eventQuery: any = { _id: eventId };
    if (isOrganizer) {
      eventQuery.organizerId = user.userId;
    }

    const event = await Event.findOne(eventQuery);
    if (!event) throw new Error('EVENT_NOT_FOUND');

    const eventObjId = new mongoose.Types.ObjectId(eventId);

    const totalInvitees = await Invitee.countDocuments({ eventId: eventObjId });
    const totalCheckIns = await CheckIn.countDocuments({ eventId: eventObjId});

    // RSVP breakdown
    const rsvpStats = await Invitee.aggregate([
      { $match: { eventId: eventObjId } },
      { $group: { _id: '$rsvpStatus', count: { $sum: 1 } } }
    ]);

    const rsvpSummary = { ACCEPTED: 0, DECLINED: 0, PENDING: 0 };
    rsvpStats.forEach((stat: any) => {
      if (stat._id in rsvpSummary) {
        (rsvpSummary as any)[stat._id] = stat.count;
      }
    });

    // Invitation Delivery Status breakdown
    const deliveryStats = await Invitee.aggregate([
      { $match: { eventId: eventObjId } },
      { $group: { _id: '$invitationStatus', count: { $sum: 1 } } }
    ]);

    const deliverySummary = { SENT: 0, PENDING: 0, FAILED: 0 };
    deliveryStats.forEach((stat: any) => {
      if (stat._id in deliverySummary) {
        (deliverySummary as any)[stat._id] = stat.count;
      }
    });

    // Check-in Method breakdown (QR vs MANUAL)
    const methodStats = await CheckIn.aggregate([
      { $match: { eventId: eventObjId} },
      { $group: { _id: '$checkInMethod', count: { $sum: 1 } } }
    ]);

    const checkInMethods = { QR: 0, MANUAL: 0 };
    methodStats.forEach((stat: any) => {
      if (stat._id in checkInMethods) {
        (checkInMethods as any)[stat._id] = stat.count;
      }
    });

    // Distinct attendees (an invitee checked into several sessions counts once)
    const attendeeIds = await CheckIn.distinct('inviteeId', { eventId: eventObjId });
    const uniqueAttendees = attendeeIds.length;

    // System users assigned to this event
    const assignments = await SystemUserAssignment.find({ eventId: eventObjId }, 'sessionIds').lean();
    const totalSystemUsers = assignments.length;

    // Sessions breakdown
    const sessions = await Session.find({ eventId: eventObjId }).sort({ 'schedule.start': 1 });
    const todayStart = startOfTodayInAppZone();
    const sessionReports = await Promise.all(
      sessions.map(async (sess) => {
        const [count, sessionAttendees, invitedCount, checkInsToday] = await Promise.all([
          CheckIn.countDocuments({ eventId: eventObjId, sessionId: sess._id }),
          CheckIn.distinct('inviteeId', { eventId: eventObjId, sessionId: sess._id }),
          // Invitees with no explicit session rules may attend every session
          Invitee.countDocuments({ eventId: eventObjId, ...inviteesAllowedFilter(sess) }),
          CheckIn.countDocuments({ eventId: eventObjId, sessionId: sess._id, checkInAt: { $gte: todayStart } })
        ]);
        // Staff with no session restriction cover every session
        const systemUsers = assignments.filter((a: any) =>
          !a.sessionIds || a.sessionIds.length === 0 || a.sessionIds.some((id: any) => id.toString() === (sess._id as any).toString())
        ).length;
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
      })
    );

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
  async getEarnings(filter: { from?: Date; to?: Date; eventId?: string; organizerId?: string } = {}) {
    const query: any = { status: { $ne: 'CANCELLED' } };
    if (filter.from || filter.to) {
      query['schedule.start'] = {};
      if (filter.from) query['schedule.start'].$gte = filter.from;
      if (filter.to) query['schedule.start'].$lte = filter.to;
    }
    if (filter.eventId) {
      query._id = filter.eventId;
    }
    if (filter.organizerId) {
      query.organizerId = filter.organizerId;
    }
    const events = await Event.find(query)
      .select('title schedule createdAt organizerId pricing status')
      .populate('organizerId', 'fullName email phone profile')
      .sort({ 'schedule.start': -1 })
      .lean();

    const sentCounts = await Invitee.aggregate([
      { $match: { eventId: { $in: events.map((e) => e._id) }, invitationStatus: InvitationStatus.SENT } },
      { $group: { _id: '$eventId', count: { $sum: 1 } } }
    ]);
    const sentByEvent = new Map(sentCounts.map((c) => [String(c._id), c.count as number]));
    const settings = await PlatformSettings.findOne({ key: 'global' }).lean();
    const currency = settings?.pricing?.currency || 'USD';

    const rows = await Promise.all(events.map(async (e: any) => {
      const locked = e.pricing && e.pricing.lockedAt;
      const rate: number | null = locked ? e.pricing.ratePerInvitee ?? null : await platformSettingsService.rateInEffectAt(new Date(e.createdAt));
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
  async getAdminOverview(filter: { from?: Date; to?: Date } = {}) {
    const earnings = await this.getEarnings(filter);

    const monthBuckets = new Map<string, { label: string; year: number; month: number; amount: number }>();
    const organizerTotals = new Map<string, { organizerId: string; name: string; email: string; phone: string; amount: number }>();

    for (const row of earnings.events) {
      if (!row.eventStart || row.amount === null) continue;
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
