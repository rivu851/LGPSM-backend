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
exports.credentialService = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const Invitee_1 = require("../models/Invitee");
const Event_1 = require("../models/Event");
const CredentialEvent_1 = require("../models/CredentialEvent");
const PassNotice_1 = require("../models/PassNotice");
const User_1 = require("../models/User");
const eventAccess_1 = require("../utils/eventAccess");
const invitation_util_1 = require("../utils/invitation.util");
const tokenCipher_1 = require("../utils/tokenCipher");
const credentialPolicy_1 = require("../utils/credentialPolicy");
const cancellationNotice_service_1 = require("./cancellationNotice.service");
const admissionWindow_1 = require("../utils/admissionWindow");
const err = (code, extra = {}) => Object.assign(new Error(code), extra);
let txSupport;
function supportsTransactions() {
    txSupport ??= (async () => {
        try {
            const hello = await mongoose_1.default.connection.db.admin().command({ hello: 1 });
            return !!(hello.setName || hello.msg === 'isdbgrid');
        }
        catch {
            return false;
        }
    })();
    return txSupport;
}
async function loadForAction(actor, inviteeId) {
    if (actor.role !== User_1.Role.ADMIN && actor.role !== User_1.Role.ORGANIZER)
        throw err('FORBIDDEN');
    if (!mongoose_1.default.Types.ObjectId.isValid(inviteeId))
        throw err('INVITEE_NOT_FOUND');
    const invitee = await Invitee_1.Invitee.findById(inviteeId).select('+qrTokenCipher');
    if (!invitee)
        throw err('INVITEE_NOT_FOUND');
    const event = await (0, eventAccess_1.findManageableEvent)(String(invitee.eventId), actor.userId, actor.role);
    if (!event)
        throw err('INVITEE_NOT_FOUND');
    return { invitee, event };
}
exports.credentialService = {
    /** True when this hash was once a guest's admission credential and a newer one has since replaced it (and it is not anyone's current one). */
    async isSupersededToken(tokenHash) {
        if (await Invitee_1.Invitee.exists({ qrTokenHash: tokenHash }))
            return false;
        const old = await CredentialEvent_1.CredentialEvent.findOne({ tokenHash }).select('+tokenHash inviteeId createdAt').lean();
        return !!old && !!(await CredentialEvent_1.CredentialEvent.exists({ inviteeId: old.inviteeId, createdAt: { $gt: old.createdAt }, type: 'REPLACED' }));
    },
    /** Called by send / resend after a pass was delivered: keeps the version counter and the history complete. Never throws into the send. */
    async recordIssuance(args) {
        const { invitee, tokenHash, source } = args;
        const had = !!(invitee.credentialVersion || (await CredentialEvent_1.CredentialEvent.exists({ inviteeId: invitee._id })));
        const version = had ? (invitee.credentialVersion || 1) + 1 : 1;
        // every admission credential has an identity of its own; history rows about it carry it, and a replacement points at the one it replaced
        const credentialId = new mongoose_1.default.Types.ObjectId();
        const previousCredentialId = had ? invitee.credentialId : undefined;
        await Invitee_1.Invitee.updateOne({ _id: invitee._id }, { $set: { credentialVersion: version, credentialId } });
        invitee.credentialVersion = version;
        invitee.credentialId = credentialId;
        const base = {
            eventId: invitee.eventId, inviteeId: invitee._id, organizerId: args.organizerId, version, source,
            actorId: mongoose_1.default.Types.ObjectId.isValid(args.actorId) ? args.actorId : undefined, actorRole: args.actorRole, tokenHash, credentialId
        };
        // issued (or replacing the earlier pass) and, in the same step, activated as the guest's current pass
        await CredentialEvent_1.CredentialEvent.create([
            { ...base, type: had ? 'REPLACED' : 'ISSUED', previousVersion: had ? version - 1 : undefined, previousCredentialId },
            { ...base, type: 'ACTIVATED' }
        ], { ordered: true });
    },
    async revoke(actor, inviteeId, input) {
        const problem = (0, credentialPolicy_1.validateReason)('REVOKE', input.category, input.note);
        if (problem)
            throw err('INVALID_REASON', { detail: problem });
        const { invitee, event } = await loadForAction(actor, inviteeId);
        if (event.status !== Event_1.EventStatus.PUBLISHED)
            throw err('EVENT_NOT_ACTIVE');
        const current = (0, credentialPolicy_1.credentialStatus)(invitee, event);
        if (current.status === 'NOT_ISSUED')
            throw err('NOT_ISSUED');
        if (invitee.credentialRevokedAt)
            return { alreadyRevoked: true, invitee };
        const now = new Date();
        const note = (0, credentialPolicy_1.cleanNote)(input.note);
        const category = input.category;
        // conditional: two revokes at once produce one revocation and one notice
        const updated = await Invitee_1.Invitee.findOneAndUpdate({ _id: invitee._id, credentialRevokedAt: null }, { $set: { credentialRevokedAt: now, credentialRevocation: { category, note, by: new mongoose_1.default.Types.ObjectId(actor.userId), at: now } } }, { new: true });
        if (!updated)
            return { alreadyRevoked: true, invitee };
        const version = invitee.credentialVersion || 1;
        const credentialEvent = await CredentialEvent_1.CredentialEvent.create({
            eventId: invitee.eventId, inviteeId: invitee._id, organizerId: event.organizerId, type: 'REVOKED', version, source: 'REVOKE', credentialId: invitee.credentialId,
            reasonCategory: category, note, actorId: actor.userId, actorRole: actor.role, tokenHash: invitee.qrTokenHash
        });
        const notice = await this.queueNotice(event, updated, credentialEvent, 'REVOKED');
        return { alreadyRevoked: false, invitee: updated, credentialEvent, notice };
    },
    async replace(actor, inviteeId, input) {
        const problem = (0, credentialPolicy_1.validateReason)('REPLACE', input.category, input.note);
        if (problem)
            throw err('INVALID_REASON', { detail: problem });
        const { invitee, event } = await loadForAction(actor, inviteeId);
        if (event.status !== Event_1.EventStatus.PUBLISHED)
            throw err('EVENT_NOT_ACTIVE');
        const current = (0, credentialPolicy_1.credentialStatus)(invitee, event);
        if (current.status === 'NOT_ISSUED')
            throw err('NOT_ISSUED');
        if (current.status === 'EXPIRED')
            throw err('CREDENTIAL_EXPIRED');
        let reviewConfirmed = false;
        if (current.status === 'REVOKED') {
            const rule = (0, credentialPolicy_1.replacementAfterRevocation)(invitee.credentialRevocation?.category);
            if (rule === 'PROHIBITED')
                throw err('REPLACEMENT_NOT_ALLOWED');
            if (rule === 'REVIEW') {
                if (input.reviewConfirmed !== true)
                    throw err('REVIEW_REQUIRED');
                reviewConfirmed = true;
            }
            if (!(0, credentialPolicy_1.eligibleForAdmission)(invitee, event))
                throw err('NOT_ELIGIBLE');
        }
        // The guest must be reachable the way they were invited: a replacement is never silent
        const plan = (await (0, cancellationNotice_service_1.planRecipients)(event._id, invitee._id)).find((p) => String(p.inviteeId) === String(invitee._id));
        if (!plan || (!plan.email && !plan.whatsapp))
            throw err('NO_DELIVERY_CHANNEL');
        // 1. Prepare everything that can fail, without touching the guest's current pass
        const rawToken = (0, invitation_util_1.generateSecureToken)();
        const newHash = (0, invitation_util_1.hashToken)(rawToken);
        const cipher = (0, tokenCipher_1.encryptToken)(rawToken);
        try {
            const { invitationService } = await Promise.resolve().then(() => __importStar(require('./invitation.service')));
            await invitationService.renderPassCard(event, { ...invitee.toObject(), _id: invitee._id }, rawToken);
        }
        catch (e) {
            throw err('CARD_RENDER_FAILED', { detail: e?.message });
        }
        // 2. Swap: one conditional update (the old hash must still be the current one), plus the history and the notice
        const previousHash = invitee.qrTokenHash;
        const previousVersion = invitee.credentialVersion || 1;
        const version = previousVersion + 1;
        const credentialId = new mongoose_1.default.Types.ObjectId();
        const previousCredentialId = invitee.credentialId;
        // a guest invited before the two secrets were separated: the token in their existing link becomes their (stable) invitation token, so that link keeps working
        const adopted = !invitee.invitationTokenHash && !!invitee.qrTokenHash;
        const adoption = adopted ? { invitationTokenHash: previousHash, ...(invitee.qrTokenCipher ? { invitationTokenCipher: invitee.qrTokenCipher } : {}) } : {};
        const note = (0, credentialPolicy_1.cleanNote)(input.note);
        const category = input.category;
        const doSwap = async (session) => {
            const swapped = await Invitee_1.Invitee.findOneAndUpdate({ _id: invitee._id, qrTokenHash: previousHash }, { $set: { qrTokenHash: newHash, qrTokenCipher: cipher, credentialRevokedAt: null, credentialRevocation: null, credentialVersion: version, credentialId, ...adoption } }, { new: true, session });
            if (!swapped)
                throw err('CONFLICT');
            const [credentialEvent] = await CredentialEvent_1.CredentialEvent.create([
                {
                    eventId: invitee.eventId, inviteeId: invitee._id, organizerId: event.organizerId, type: 'REPLACED', version, previousVersion, source: 'REPLACE', credentialId, previousCredentialId,
                    reasonCategory: category, note, actorId: actor.userId, actorRole: actor.role, reviewConfirmed: reviewConfirmed || undefined, tokenHash: newHash
                },
                { eventId: invitee.eventId, inviteeId: invitee._id, organizerId: event.organizerId, type: 'ACTIVATED', version, source: 'REPLACE', credentialId, actorId: actor.userId, actorRole: actor.role, tokenHash: newHash }
            ], { session, ordered: true });
            const notice = await this.queueNotice(event, swapped, credentialEvent, 'REPLACED', session);
            return { swapped, credentialEvent, notice };
        };
        let result;
        if (await supportsTransactions()) {
            const session = await mongoose_1.default.startSession();
            try {
                let r;
                await session.withTransaction(async () => { r = await doSwap(session); });
                result = r;
            }
            finally {
                await session.endSession();
            }
        }
        else {
            // No transactions (standalone database): swap first, and undo it if the history/notice cannot be written
            const swapped = await Invitee_1.Invitee.findOneAndUpdate({ _id: invitee._id, qrTokenHash: previousHash }, { $set: { qrTokenHash: newHash, qrTokenCipher: cipher, credentialRevokedAt: null, credentialRevocation: null, credentialVersion: version, credentialId, ...adoption } }, { new: true });
            if (!swapped)
                throw err('CONFLICT');
            try {
                const [credentialEvent] = await CredentialEvent_1.CredentialEvent.create([
                    {
                        eventId: invitee.eventId, inviteeId: invitee._id, organizerId: event.organizerId, type: 'REPLACED', version, previousVersion, source: 'REPLACE', credentialId, previousCredentialId,
                        reasonCategory: category, note, actorId: actor.userId, actorRole: actor.role, reviewConfirmed: reviewConfirmed || undefined, tokenHash: newHash
                    },
                    { eventId: invitee.eventId, inviteeId: invitee._id, organizerId: event.organizerId, type: 'ACTIVATED', version, source: 'REPLACE', credentialId, actorId: actor.userId, actorRole: actor.role, tokenHash: newHash }
                ], { ordered: true });
                const notice = await this.queueNotice(event, swapped, credentialEvent, 'REPLACED');
                result = { swapped, credentialEvent, notice };
            }
            catch (e) {
                const unset = { ...(previousCredentialId ? {} : { credentialId: '' }), ...(adopted ? { invitationTokenHash: '', invitationTokenCipher: '' } : {}) };
                await Invitee_1.Invitee.updateOne({ _id: invitee._id, qrTokenHash: newHash }, {
                    $set: { qrTokenHash: previousHash, qrTokenCipher: invitee.qrTokenCipher, credentialRevokedAt: invitee.credentialRevokedAt ?? null, credentialRevocation: invitee.credentialRevocation ?? null, credentialVersion: previousVersion, ...(previousCredentialId ? { credentialId: previousCredentialId } : {}) },
                    ...(Object.keys(unset).length ? { $unset: unset } : {})
                });
                await CredentialEvent_1.CredentialEvent.deleteMany({ inviteeId: invitee._id, tokenHash: newHash }).catch(() => undefined);
                throw e;
            }
        }
        const { notificationsStarted } = await this.startNotices(result.notice);
        return { invitee: result.swapped, credentialEvent: result.credentialEvent, notice: result.notice, notificationsStarted };
    },
    /** Stores the notice for a credential change (inside the same transaction as the change when one is open). */
    async queueNotice(event, invitee, credentialEvent, kind, session) {
        const plan = (await (0, cancellationNotice_service_1.planRecipients)(event._id, invitee._id)).find((p) => String(p.inviteeId) === String(invitee._id));
        const use = (on) => (on ? { status: 'PENDING', attempts: 0 } : { status: 'NOT_USED', attempts: 0 });
        const noChannel = !plan || (!plan.email && !plan.whatsapp);
        const [doc] = await PassNotice_1.PassNotice.create([{
                eventId: event._id, inviteeId: invitee._id, organizerId: event.organizerId, credentialEventId: credentialEvent._id, kind,
                credentialVersion: credentialEvent.version,
                // a guest who was never reachable is reported, not silently skipped
                email: noChannel ? { status: 'UNAVAILABLE', attempts: 0, failureReason: 'No earlier invitation reached this guest on any channel' } : use(plan?.email),
                whatsapp: use(plan?.whatsapp)
            }], { session });
        return doc;
    },
    async startNotices(notice) {
        const { passNoticeService } = await Promise.resolve().then(() => __importStar(require('./passNotice.service')));
        passNoticeService.processNotice(notice._id).catch((e) => console.error('Pass notice dispatch failed:', e?.message));
        return { notificationsStarted: true };
    },
    /** The guest's pass history, newest last, with each change's notice outcome. No tokens. */
    async history(actor, eventId, opts = {}) {
        if (actor.role !== User_1.Role.ADMIN && actor.role !== User_1.Role.ORGANIZER)
            throw err('FORBIDDEN');
        const event = await (0, eventAccess_1.findManageableEvent)(eventId, actor.userId, actor.role);
        if (!event)
            throw err('EVENT_NOT_FOUND');
        const filter = { eventId: event._id };
        if (opts.inviteeId && mongoose_1.default.Types.ObjectId.isValid(opts.inviteeId))
            filter.inviteeId = opts.inviteeId;
        const events = await CredentialEvent_1.CredentialEvent.find(filter).sort({ createdAt: -1, _id: -1 }).limit(Math.min(opts.limit || 100, 200)).lean();
        const notices = await PassNotice_1.PassNotice.find({ credentialEventId: { $in: events.map((e) => e._id) } }).lean();
        const byEvent = new Map(notices.map((n) => [String(n.credentialEventId), n]));
        const invitees = await Invitee_1.Invitee.find({ _id: { $in: events.map((e) => e.inviteeId) } }).select('name qrTokenHash credentialRevokedAt credentialVersion credentialId').lean();
        const names = new Map(invitees.map((i) => [String(i._id), i.name]));
        const Users = (await Promise.resolve().then(() => __importStar(require('../models/User')))).User;
        const actors = await Users.find({ _id: { $in: events.map((e) => e.actorId).filter(Boolean) } }).select('fullName').lean();
        const actorNames = new Map(actors.map((a) => [String(a._id), a.fullName]));
        const rows = events.map((e) => {
            const n = byEvent.get(String(e._id));
            return {
                _id: e._id, inviteeId: e.inviteeId, inviteeName: names.get(String(e.inviteeId)) || 'Guest', type: e.type, version: e.version, previousVersion: e.previousVersion,
                credentialId: e.credentialId, previousCredentialId: e.previousCredentialId, result: e.result || 'SUCCESS', derived: false,
                source: e.source, reasonCategory: e.reasonCategory, note: e.note, reviewConfirmed: !!e.reviewConfirmed, actor: e.actorId ? actorNames.get(String(e.actorId)) || e.actorRole : undefined, at: e.createdAt,
                // historical state of the pass this row is about: a replaced pass is "Replaced" (a revoked-then-replaced one keeps its Revoked row)
                notice: n ? { kind: n.kind, email: n.email, whatsapp: n.whatsapp } : undefined
            };
        });
        // EXPIRED is not stored (no background job, the door applies the event's state on every scan): it is shown as a row derived from
        // the event, for each guest whose current pass is expired, dated at the moment that made it so.
        const closesAt = (() => { const w = (0, admissionWindow_1.effectiveAdmission)(event); return w?.closesAt ? new Date(w.closesAt) : undefined; })();
        for (const g of invitees) {
            const st = (0, credentialPolicy_1.credentialStatus)(g, event);
            if (st.status !== 'EXPIRED')
                continue;
            const at = st.reason === 'EVENT_CANCELLED' ? event.cancelledAt : st.reason === 'EVENT_COMPLETED' ? event.closedAt || event.updatedAt : closesAt;
            rows.push({
                _id: `expired-${g._id}`, inviteeId: g._id, inviteeName: g.name, type: 'EXPIRED', version: g.credentialVersion || 1, previousVersion: undefined,
                credentialId: g.credentialId, previousCredentialId: undefined, result: 'SUCCESS', derived: true, source: 'EVENT',
                reasonCategory: st.reason, note: undefined, reviewConfirmed: false, actor: undefined, at: at || new Date(), notice: undefined
            });
        }
        return rows.sort((a, b) => +new Date(b.at) - +new Date(a.at));
    }
};
