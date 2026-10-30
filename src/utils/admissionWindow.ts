import { env } from '../config/env';

// Admission ("check-in") window.
//
// An event has two separate notions of time: when it is *held* (`schedule`) and when guests may be *admitted*
// (`admission`). Without explicit admission values the window is the schedule itself: it opens at the scheduled
// start and closes at the scheduled end. Nothing adds a grace period after the end.
//
// All values are UTC instants; the clock is always the server's. The window is half-open: it is open at `opensAt`
// and no longer open at exactly `closesAt`. The platform timezone (APP_TIMEZONE) is used only to *write* times in
// messages; it never changes which instant a window covers.

export interface AdmissionWindow {
  opensAt: Date;
  closesAt: Date;
  /** true when the value comes from the event's schedule rather than an explicit admission setting */
  opensAtIsDefault: boolean;
  closesAtIsDefault: boolean;
}

type Source = { schedule?: { start?: Date | string | null; end?: Date | string | null } | null; admission?: { opensAt?: Date | string | null; closesAt?: Date | string | null } | null };

const asDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function effectiveAdmission(event: Source): AdmissionWindow | null {
  const explicitOpen = asDate(event.admission?.opensAt);
  const explicitClose = asDate(event.admission?.closesAt);
  const opensAt = explicitOpen ?? asDate(event.schedule?.start);
  const closesAt = explicitClose ?? asDate(event.schedule?.end);
  if (!opensAt || !closesAt) return null;
  return { opensAt, closesAt, opensAtIsDefault: !explicitOpen, closesAtIsDefault: !explicitClose };
}

export type AdmissionState = 'NOT_OPEN' | 'OPEN' | 'CLOSED';

export function admissionState(window: Pick<AdmissionWindow, 'opensAt' | 'closesAt'>, now: Date): AdmissionState {
  if (now.getTime() < window.opensAt.getTime()) return 'NOT_OPEN';
  if (now.getTime() >= window.closesAt.getTime()) return 'CLOSED';
  return 'OPEN';
}

/** "31 Oct 2026, 9:00 AM IST", written in the platform timezone so staff read the same wall-clock time as the organizer. */
export function formatAdmissionTime(d: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: env.APP_TIMEZONE, day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
  }).format(d);
}

/** Rule for what an organizer may save. Returns an error message, or null when acceptable. */
export function validateAdmissionInput(
  schedule: { start?: Date | string | null; end?: Date | string | null },
  admission: { opensAt?: Date | string | null; closesAt?: Date | string | null } | null | undefined
): string | null {
  if (!admission) return null;
  for (const key of ['opensAt', 'closesAt'] as const) {
    const raw = admission[key];
    if (raw !== null && raw !== undefined && raw !== '' && !asDate(raw)) return 'Check-in times must be valid dates.';
  }
  const w = effectiveAdmission({ schedule, admission });
  if (!w) return null;
  if (w.opensAt.getTime() >= w.closesAt.getTime()) return 'Check-in must open before it closes.';
  return null;
}
