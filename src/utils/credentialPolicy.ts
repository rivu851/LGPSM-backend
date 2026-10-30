import { RsvpStatus } from '../models/Invitee';
import { effectiveAdmission, admissionState } from './admissionWindow';

// Access pass ("credential") rules. A guest's pass is separate from their invitation delivery and from their RSVP.

export const REASON_CATEGORIES = [
  'LOST_OR_COMPROMISED',
  'FORWARDED_OR_SHARED',
  'DUPLICATE_OR_INCORRECT',
  'ACCESS_WITHDRAWN',
  'ATTENDEE_REQUESTED_REPLACEMENT',
  'OTHER'
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

export const NOTE_MAX = 500;

export type CredentialAction = 'REVOKE' | 'REPLACE';

/** Category is mandatory, the explanation optional - except for OTHER. "Access withdrawn" is never a reason to issue a new pass. */
export function validateReason(action: CredentialAction, category: unknown, note: unknown): string | null {
  if (typeof category !== 'string' || !(REASON_CATEGORIES as readonly string[]).includes(category)) return 'Choose a reason.';
  if (action === 'REPLACE' && category === 'ACCESS_WITHDRAWN') return '"Access withdrawn" is not a reason to issue a new pass.';
  const text = typeof note === 'string' ? note.trim() : '';
  if (category === 'OTHER' && !text) return 'Explain the reason when you choose Other.';
  if (text.length > NOTE_MAX) return `The explanation can be at most ${NOTE_MAX} characters.`;
  return null;
}

export const cleanNote = (note: unknown): string | undefined => {
  const t = typeof note === 'string' ? note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, NOTE_MAX) : '';
  return t || undefined;
};

/**
 * May a pass that was revoked for this reason be replaced through the ordinary Replace action?
 *  ALLOWED    lost/compromised, forwarded/shared, duplicate/incorrect, attendee-requested
 *  PROHIBITED access withdrawn
 *  REVIEW     other: needs an explicit review confirmation first
 */
export function replacementAfterRevocation(category: string | undefined | null): 'ALLOWED' | 'PROHIBITED' | 'REVIEW' {
  if (category === 'ACCESS_WITHDRAWN') return 'PROHIBITED';
  if (category === 'OTHER') return 'REVIEW';
  return 'ALLOWED';
}

export type CredentialStatus = 'NOT_ISSUED' | 'ACTIVE' | 'REVOKED' | 'EXPIRED';

/**
 * The status of the guest's CURRENT pass, derived on read. "Replaced" is deliberately not a value here: a replaced pass is
 * history (CredentialEvent), and a guest with a newer pass is Active.
 */
export function credentialStatus(
  invitee: { qrTokenHash?: string | null; credentialRevokedAt?: Date | null },
  event: { status?: string; schedule?: any; admission?: any },
  now: Date = new Date()
): { status: CredentialStatus; reason?: 'EVENT_CANCELLED' | 'EVENT_COMPLETED' | 'ADMISSION_CLOSED' } {
  if (!invitee.qrTokenHash) return { status: 'NOT_ISSUED' };
  if (invitee.credentialRevokedAt) return { status: 'REVOKED' };
  if (event.status === 'CANCELLED') return { status: 'EXPIRED', reason: 'EVENT_CANCELLED' };
  if (event.status === 'COMPLETED') return { status: 'EXPIRED', reason: 'EVENT_COMPLETED' };
  const w = effectiveAdmission(event as any);
  if (w && admissionState(w, now) === 'CLOSED') return { status: 'EXPIRED', reason: 'ADMISSION_CLOSED' };
  return { status: 'ACTIVE' };
}

/** The same RSVP rules the door applies (checkIn.service.validateInviteeEligibility), so a replacement is never issued to someone who could not enter. */
export function eligibleForAdmission(invitee: { rsvpStatus?: string }, event: { rsvp?: any }): boolean {
  if (event.rsvp && event.rsvp.enabled) {
    if (invitee.rsvpStatus === RsvpStatus.DECLINED && !event.rsvp.allowDeclined) return false;
    if (invitee.rsvpStatus === RsvpStatus.PENDING && !event.rsvp.allowNotResponded && !event.rsvp.allowAllInvited) return false;
  }
  return true;
}
