import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';

export const authController = {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.register(req.body);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  },

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.login(req.body);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  },

  async googleAuth(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.googleAuth(req.body.token);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  },

  async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.refresh(req.body.refreshToken);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.logout(req.body.refreshToken);
      res.status(200).json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
      next(error);
    }
  },

  async forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.forgotPassword(req.body.email);
      res.status(200).json({ success: true, message: 'If the email exists, a reset link has been generated.' });
    } catch (error) {
      next(error);
    }
  },

  async resetPassword(req: Request, res: Response, next: NextFunction) {
    try {
      await authService.resetPassword(req.body.token, req.body.newPassword);
      res.status(200).json({ success: true, message: 'Password reset successfully' });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Verifies the 6-digit OTP sent to the organizer's email.
   * On success the account is activated; no tokens are issued.
   * The frontend redirects the user to the sign-in page.
   */
  async verifyEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.verifyEmail(req.body.email, req.body.code);
      res.status(200).json({ success: true, data: result, message: 'Email verified successfully. You can now sign in.' });
    } catch (error) {
      next(error);
    }
  },

  /**
   * Resends a fresh OTP, subject to a 60-second cooldown.
   * Returns success even when the email is not found (enumeration prevention).
   */
  async resendVerificationCode(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.resendVerificationCode(req.body.email);
      res.status(200).json({ success: true, data: result, message: 'A new verification code has been sent to your email.' });
    } catch (error) {
      next(error);
    }
  },
};
