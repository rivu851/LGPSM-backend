import rateLimit, { Options, ipKeyGenerator } from 'express-rate-limit';
import { securityEvent } from '../utils/securityLog';

// Records every throttled request as a security event, then answers exactly as the default handler would
const logged = (limiter: string) => (req: any, res: any, _next: any, options: Options) => {
  securityEvent('RATE_LIMITED', req, { limiter });
  res.status(options.statusCode).send(options.message);
};

const skipInTest = () => process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_TESTS !== 'true';

/**
 * 20 requests per 15 minutes per IP: registration and password recovery. Sign-in and token refresh have limits of their own below:
 * many people share one address at a venue or an office, and refusing a refresh there would sign door staff out mid-event.
 */
export const authRateLimiter = rateLimit({
  handler: logged('authRateLimiter'),
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

/** Sign-in, per network: generous, because a whole staff team may sign in from one venue connection at once. */
export const loginIpLimiter = rateLimit({
  handler: logged('loginIpLimiter'),
  windowMs: 15 * 60 * 1000,
  max: 150,
  message: { success: false, message: 'Too many sign-in attempts from this network. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

const loginIdentifier = (req: any) => String(req.body?.email || req.body?.phone || '').trim().toLowerCase().slice(0, 200);

/** Failed sign-ins for one account from one address: stops password guessing without letting a stranger lock the person out everywhere. */
export const loginAccountLimiter = rateLimit({
  handler: logged('loginAccountLimiter'),
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => `${loginIdentifier(req)}|${ipKeyGenerator(req.ip)}`,
  skipSuccessfulRequests: true,
  message: { success: false, message: 'Too many failed sign-in attempts for this account. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

/** Token refresh: every signed-in device does this every few minutes, so the ceiling only stops floods. */
export const refreshRateLimiter = rateLimit({
  handler: logged('refreshRateLimiter'),
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { success: false, message: 'Too many requests from this network. Please try again shortly.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

/**
 * Strict limiter for OTP verification — 10 attempts per 10 minutes per IP.
 * This is separate from the account-level attempt counter in the service layer.
 */
export const verifyEmailRateLimiter = rateLimit({
  handler: logged('verifyEmailRateLimiter'),
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many verification attempts. Please try again in 10 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

/**
 * Resend limiter — 5 resend requests per 10 minutes per IP.
 * The 60-second account-level cooldown is enforced separately in the service.
 */
export const resendVerificationRateLimiter = rateLimit({
  handler: logged('resendVerificationRateLimiter'),
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many resend requests. Please try again in 10 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

/**
 * Public contact form, two layers (in-memory stores: per server instance, which matches the single
 * Render instance this API runs on). Both are skipped under test unless a test opts in with
 * ENABLE_RATE_LIMIT_TESTS, so rate limiting itself can be tested without slowing other suites.
 *
 * - Attempts: 30 requests / 15 min / IP counting everything, so invalid-payload hammering is bounded.
 * - Submissions: 5 / 15 min / IP counting only requests that were accepted (skipFailedRequests), so a
 *   visitor correcting validation mistakes is not locked out.
 */
export const contactAttemptLimiter = rateLimit({
  handler: logged('contactAttemptLimiter'),
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many requests from this network. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

export const contactRateLimiter = rateLimit({
  handler: logged('contactRateLimiter'),
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many messages sent from this network. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  skip: skipInTest,
});

/**
 * Public invitation pages and RSVP (token in the URL). Tokens are 256-bit random so guessing is not
 * feasible; this bounds scraping and request floods against an unauthenticated route. The ceiling is
 * generous because many guests can share one venue network.
 */
export const publicInvitationLimiter = rateLimit({
  handler: logged('publicInvitationLimiter'),
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { success: false, message: 'Too many requests from this network. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

/**
 * Live card preview in the Add Event form: rendering an image is far more expensive than a normal request, and the
 * form asks again as the organizer types (debounced), so the ceiling allows steady typing but not a flood.
 */
export const cardPreviewLimiter = rateLimit({
  handler: logged('cardPreviewLimiter'),
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many preview requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

// Keyed by the signed-in user (these routes always sit behind authenticate), so one organizer cannot spend another's allowance
const perUser = (req: any) => req.user?.userId || ipKeyGenerator(req.ip);

/** Starting a generation costs real provider quota: 10 requests per hour per user (the per-day quota is enforced by the service). */
export const templateGenerationLimiter = rateLimit({
  handler: logged('templateGenerationLimiter'),
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: perUser,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many design requests. Please wait before generating again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

/** Status polling and previews: generous, because the apps poll while a design is being made. */
export const templateGenerationReadLimiter = rateLimit({
  handler: logged('templateGenerationReadLimiter'),
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: perUser,
  message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

/** Full-size renders are heavier than previews. */
export const templateRenderLimiter = rateLimit({
  handler: logged('templateRenderLimiter'),
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: perUser,
  message: { success: false, message: 'Too many image requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

const perUserLimiter = (name: string, max: number, windowMs: number, message: string) => rateLimit({
  handler: logged(name),
  windowMs,
  max,
  keyGenerator: perUser,
  message: { success: false, code: 'RATE_LIMITED', message },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

/** Door scanning: far above what one person can scan, it only bounds a runaway client or a stolen session probing passes. */
export const checkInLimiter = perUserLimiter('checkInLimiter', 300, 60 * 1000, 'Too many check-in requests. Please wait a moment.');
/** Sending messages costs money and reputation with the mail provider. */
export const invitationSendLimiter = perUserLimiter('invitationSendLimiter', 60, 60 * 1000, 'Too many send requests. Please wait a moment.');
/** Revoke and replace each send a message to a guest. */
export const credentialActionLimiter = perUserLimiter('credentialActionLimiter', 60, 60 * 1000, 'Too many access-pass changes. Please wait a moment.');
/** Parsing a spreadsheet is the most expensive thing a request can ask for. */
export const importLimiter = perUserLimiter('importLimiter', 30, 60 * 1000, 'Too many uploads. Please wait a moment.');
/** Uploads are kept in the database, so they are bounded per account. */
export const mediaUploadLimiter = perUserLimiter('mediaUploadLimiter', 30, 15 * 60 * 1000, 'Too many image uploads. Please wait a few minutes.');
