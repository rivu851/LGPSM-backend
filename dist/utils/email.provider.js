"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
const sendEmail = async (to, subject, html, attachments) => {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!host || !user || !pass) {
        // Explicit failure if not configured, rather than silent mock success
        console.error('Email Delivery Error: SMTP credentials are not fully configured in environment variables.');
        throw new Error('PROVIDER_NOT_CONFIGURED');
    }
    const transporter = nodemailer_1.default.createTransport({
        host,
        port: parseInt(port || '587', 10),
        auth: {
            user,
            pass
        }
    });
    try {
        const info = await transporter.sendMail({
            from: process.env.SMTP_FROM || '"Event Management Platform" <noreply@events.local>',
            to,
            subject,
            html,
            attachments
        });
        // Do not log PII or full response unless in debug mode
        return true;
    }
    catch (error) {
        console.error('Email Delivery Error:', error instanceof Error ? error.message : 'Unknown error');
        throw new Error('FAILED_TO_SEND_EMAIL');
    }
};
exports.sendEmail = sendEmail;
