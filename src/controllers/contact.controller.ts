import { Request, Response } from 'express';
import { contactService } from '../services/contact.service';

const RECEIVED_MESSAGE = 'Thanks — your message has been received. We will get back to you soon.';

export const contactController = {
  // POST /api/v1/public/contact
  async submit(req: Request, res: Response) {
    // Honeypot filled in: an automated form-filler. Answer like a success but store and notify nothing.
    if (typeof req.body.website === 'string' && req.body.website.trim() !== '') {
      return res.status(200).json({
        success: true,
        message: RECEIVED_MESSAGE,
        data: { status: 'NEW', receivedAt: new Date().toISOString(), duplicate: false }
      });
    }

    try {
      const { name, email, phone, message } = req.body;
      const receipt = await contactService.submit(
        { name, email, phone, message },
        { ip: req.ip, userAgent: req.get('user-agent') || undefined }
      );
      return res.status(receipt.duplicate ? 200 : 201).json({
        success: true,
        message: RECEIVED_MESSAGE,
        data: {
          id: receipt.id,
          status: receipt.status,
          receivedAt: receipt.receivedAt.toISOString(),
          duplicate: receipt.duplicate
        }
      });
    } catch (error: any) {
      console.error('Contact submission failed:', error?.message || error);
      return res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'We could not save your message right now. Please try again in a moment.'
      });
    }
  }
};
