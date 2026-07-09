import { HttpClient } from '../../src/core/http.js';
import { Telegram } from '../../src/core/telegram.js';
import { adapters } from '../../src/sources/index.js';
import { runScan } from '../../src/core/run.js';
import { checkCronSecret } from '../../src/web/cron-auth.js';
import { bootstrap } from '../_lib/bootstrap.js';

// Lazy init (no top-level await) so a hung/failed bootstrap surfaces as JSON, not a
// silent timeout. bootstrap() is a cached singleton, so this runs once per instance.
export default async function handler(req: Request): Promise<Response> {
  if (!checkCronSecret(req.headers.get('authorization') ?? undefined, process.env.CRON_SECRET)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const { db, cfg } = await bootstrap();
    const http = new HttpClient({
      minGapMs: cfg.scan.minRequestGapMs,
      hostGapOverrides: { 'last-minute.zajezdy.cz': 5000 },
    });
    const telegram =
      cfg.telegramToken && cfg.telegramChatId ? new Telegram(cfg.telegramToken, cfg.telegramChatId) : null;
    const summary = await runScan({ db, cfg, http, telegram, adapters, concurrency: 'concurrent', log: (s) => console.log(s) });
    return Response.json(summary);
  } catch (e) {
    const err = e as Error;
    return Response.json({ error: 'scan failed', detail: err?.message, stack: err?.stack }, { status: 500 });
  }
}
