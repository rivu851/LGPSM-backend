import { Request, Response, NextFunction } from 'express';
import { userService } from '../services/user.service';
import { systemUserAssignmentService } from '../services/systemUserAssignment.service';

export const userController = {
  async getProfile(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw { statusCode: 401, message: 'Unauthorized' };
      const user = await userService.getProfile(req.user.userId);
      res.status(200).json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  },

  async updateProfile(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw { statusCode: 401, message: 'Unauthorized' };
      const user = await userService.updateProfile(req.user.userId, req.body);
      res.status(200).json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  },

  async changePassword(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw { statusCode: 401, message: 'Unauthorized' };
      const result = await userService.changePassword(req.user.userId, req.body.currentPassword, req.body.newPassword);
      res.status(200).json({ success: true, data: result, message: 'Password updated successfully' });
    } catch (error) {
      next(error);
    }
  },

  async createUser(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw { statusCode: 401, message: 'Unauthorized' };
      const user = await userService.createUser(req.user, req.body);
      res.status(201).json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  },

  async getUsers(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw { statusCode: 401, message: 'Unauthorized' };
      const roleFilter = req.query.role as string | undefined;
      const includeInactive = req.query.includeInactive === 'true';
      const users = await userService.getUsers(req.user, roleFilter, includeInactive);
      res.status(200).json({ success: true, data: users });
    } catch (error) {
      next(error);
    }
  },

  async getUserAssignments(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw { statusCode: 401, message: 'Unauthorized' };
      const assignments = await systemUserAssignmentService.getAssignmentsByUser(req.params.id as string);
      res.status(200).json({ success: true, data: assignments });
    } catch (error) {
      next(error);
    }
  },

  async deleteUser(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw { statusCode: 401, message: 'Unauthorized' };
      const result = await userService.deleteUser(req.user, req.params.id as string);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  },

  async updateUser(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw { statusCode: 401, message: 'Unauthorized' };
      const user = await userService.updateUser(req.user, req.params.id as string, req.body);
      res.status(200).json({ success: true, data: user });
    } catch (error) {
      next(error);
    }
  }
};
