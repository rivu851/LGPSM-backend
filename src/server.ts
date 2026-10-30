import dns from 'dns';
import app from './app';
import connectDatabase from './config/database';
import { env } from './config/env';
import { passNoticeService } from './services/passNotice.service';
import { cancellationNoticeService } from './services/cancellationNotice.service';
import { recoverOnStartup } from './services/stitch/templateGeneration.service';

// Render containers have no outbound IPv6 route. Node's default DNS ordering can still return an
// IPv6 address first for dual-stack hosts (smtp.gmail.com, some third-party APIs), which then
// fails with ENETUNREACH. Prefer IPv4 results process-wide so every outbound connection benefits,
// not just SMTP.
dns.setDefaultResultOrder('ipv4first');

async function startServer() {
  try {
    await connectDatabase();
    // generation jobs a restart interrupted are failed (not left "running"), and queued ones resume
    await recoverOnStartup().catch((e) => console.error('Template generation recovery failed:', e?.message));

    // cancellation notices that were still waiting when the process stopped are sent now (they are stored, not held in memory)
    passNoticeService.resumeAll().catch((e) => console.error('Pass notice resume failed:', e?.message));
    cancellationNoticeService.resumeAll().catch((e) => console.error('Cancellation notice resume failed:', e?.message));

    app.listen(env.PORT, () => {
      console.log(`Server is running on port ${env.PORT}`);
      console.log(`Environment: ${env.NODE_ENV}`);
    });
  } catch (error: any) {
    console.error(`MongoDB connection failed: ${error.message}`);
    process.exit(1);
  }
}

startServer();
