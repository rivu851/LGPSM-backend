import { Request, Response, NextFunction } from 'express';
import { systemUserAssignmentService } from '../services/systemUserAssignment.service';

export const systemUserAssignmentController = {
  async createAssignment(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const eventId = req.params.eventId as string;
      
      const assignment = await systemUserAssignmentService.createAssignment(eventId, organizerId, req.body);
      
      res.status(201).json({ success: true, data: assignment });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else if (error.message === 'INVALID_USER') {
        res.status(400).json({ error: 'Bad Request', message: 'Invalid or inactive system user', details: [] });
      } else if (error.message === 'DUPLICATE_ASSIGNMENT') {
        res.status(409).json({ error: 'Conflict', message: 'User is already assigned to this event', details: [] });
      } else if (error.message === 'INVALID_SESSIONS') {
        res.status(400).json({ error: 'Bad Request', message: 'One or more sessions are invalid or belong to a different event', details: [] });
      } else {
        next(error);
      }
    }
  },

  async getAssignmentsByEvent(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const eventId = req.params.eventId as string;
      
      const assignments = await systemUserAssignmentService.getAssignmentsByEvent(eventId, organizerId);
      
      res.status(200).json({ success: true, data: assignments });
    } catch (error: any) {
      if (error.message === 'EVENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Event not found or inaccessible', details: [] });
      } else {
        next(error);
      }
    }
  },

  async getMyAssignments(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as any).user.userId;

      const assignments = await systemUserAssignmentService.getAssignmentsByUser(userId, (req as any).user);
      
      res.status(200).json({ success: true, data: assignments });
    } catch (error: any) {
      next(error);
    }
  },

  async updateAssignment(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const assignmentId = req.params.assignmentId as string;
      
      const assignment = await systemUserAssignmentService.updateAssignment(assignmentId, organizerId, req.body.sessionIds);
      
      res.status(200).json({ success: true, data: assignment });
    } catch (error: any) {
      if (error.message === 'ASSIGNMENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Assignment not found or inaccessible', details: [] });
      } else if (error.message === 'INVALID_SESSIONS') {
        res.status(400).json({ error: 'Bad Request', message: 'One or more sessions are invalid or belong to a different event', details: [] });
      } else {
        next(error);
      }
    }
  },

  async deleteAssignment(req: Request, res: Response, next: NextFunction) {
    try {
      const organizerId = (req as any).user.userId;
      const assignmentId = req.params.assignmentId as string;
      
      const assignment = await systemUserAssignmentService.deleteAssignment(assignmentId, organizerId);
      
      res.status(200).json({ success: true, data: { assignmentId: assignment._id, deleted: true } });
    } catch (error: any) {
      if (error.message === 'ASSIGNMENT_NOT_FOUND') {
        res.status(404).json({ error: 'Not Found', message: 'Assignment not found or inaccessible', details: [] });
      } else {
        next(error);
      }
    }
  }
};
