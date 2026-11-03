import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import {
  authRateLimiter,
  loginIpLimiter,
  loginAccountLimiter,
  refreshRateLimiter,
  verifyEmailRateLimiter,
  resendVerificationRateLimiter,
} from '../middlewares/rateLimiter';
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  verifyResetOtpSchema,
} from '../validators/auth.validator';
import { Request, Response, NextFunction } from 'express';

const router = Router();

// Middleware to validate body using Zod
const validate = (schema: any) => (req: Request, res: Response, next: NextFunction) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ success: false, errors: result.error.format() });
  }
  req.body = result.data;
  next();
};

// Apply the base auth rate limiter to all routes in this router

// Tokens and reset codes travel in these answers: nothing may keep a copy
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

router.post('/register', authRateLimiter, validate(registerSchema), authController.register);
router.post('/login', loginIpLimiter, loginAccountLimiter, validate(loginSchema), authController.login);
router.post('/refresh', refreshRateLimiter, validate(refreshTokenSchema), authController.refresh);
router.post('/logout', refreshRateLimiter, authController.logout);
router.post('/forgot-password', authRateLimiter, validate(forgotPasswordSchema), authController.forgotPassword);
// Mobile reset flow: emailed 4-digit code → short-lived reset token (stricter limiters on top of authRateLimiter)
router.post(
  '/forgot-password/otp',
  authRateLimiter,
  resendVerificationRateLimiter,
  validate(forgotPasswordSchema),
  authController.requestPasswordResetOtp
);
router.post(
  '/forgot-password/verify-otp',
  authRateLimiter,
  verifyEmailRateLimiter,
  validate(verifyResetOtpSchema),
  authController.verifyPasswordResetOtp
);
router.post('/reset-password', authRateLimiter, validate(resetPasswordSchema), authController.resetPassword);

// Email verification — additional, stricter rate limiters on top of authRateLimiter
router.post(
  '/verify-email',
  authRateLimiter,
  verifyEmailRateLimiter,
  validate(verifyEmailSchema),
  authController.verifyEmail
);
router.post(
  '/resend-verification',
  authRateLimiter,
  resendVerificationRateLimiter,
  validate(resendVerificationSchema),
  authController.resendVerificationCode
);

export default router;
