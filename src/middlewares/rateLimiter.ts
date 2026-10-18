import rateLimit, { Options } from 'express-rate-limit';
import { securityEvent } from '../utils/securityLog';

// Records every throttled request as a security event, then answers exactly as the default handler would
const logged = (limiter: string) => (req: any, res: any, _next: any, options: Options) => {
  securityEvent('RATE_LIMITED', req, { limiter });
  res.status(options.statusCode).send(options.message);
};

/** 20 requests per 15 minutes per IP — applied to all auth endpoints. */
export const authRateLimiter = rateLimit({
  handler: logged('authRateLimiter'),
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many requests from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
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
  skip: () => process.env.NODE_ENV === 'test',
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
  skip: () => process.env.NODE_ENV === 'test',
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
const skipInTest = () => process.env.NODE_ENV === 'test' && process.env.ENABLE_RATE_LIMIT_TESTS !== 'true';

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
