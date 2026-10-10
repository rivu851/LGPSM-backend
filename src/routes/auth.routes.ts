import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import {
  authRateLimiter,
  verifyEmailRateLimiter,
  resendVerificationRateLimiter,
} from '../middlewares/rateLimiter';
import {
  registerSchema,
  loginSchema,
  googleAuthSchema,
  refreshTokenSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  resendVerificationSchema,
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
router.use(authRateLimiter);

router.post('/register', validate(registerSchema), authController.register);
router.post('/login', validate(loginSchema), authController.login);
router.post('/google', validate(googleAuthSchema), authController.googleAuth);
router.post('/refresh', validate(refreshTokenSchema), authController.refresh);
router.post('/logout', authController.logout);
router.post('/forgot-password', validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword);

// Email verification — additional, stricter rate limiters on top of authRateLimiter
router.post(
  '/verify-email',
  verifyEmailRateLimiter,
  validate(verifyEmailSchema),
  authController.verifyEmail
);
router.post(
  '/resend-verification',
  resendVerificationRateLimiter,
  validate(resendVerificationSchema),
  authController.resendVerificationCode
);

export default router;
