import { getRequestListener } from '@hono/node-server';
import { HttpClient } from '../../src/core/http.js';
import { Telegram } from '../../src/core/telegram.js';
import { adapters } from '../../src/sources/index.js';
import { runScan } from '../../src/core/run.js';
import { checkCronSecret } from '../../src/web/cron-auth.js';
import { bootstrap } from '../_lib/bootstrap.js';

// getRequestListener bridges this fetch handler to Vercel's legacy Node (req, res)
// signature (see api/index.ts). `req` here is a real Web Request, so req.headers.get works.
async function fetchHandler(req: Request): Promise<Response> {
  if (!checkCronSecret(req.headers.get('authorization') ?? undefined, process.env.CRON_SECRET)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { db, cfg } = await bootstrap();
  const http = new HttpClient({
    minGapMs: cfg.scan.minRequestGapMs,
    hostGapOverrides: { 'last-minute.zajezdy.cz': 5000 },
  });
  const telegram =
    cfg.telegramToken && cfg.telegramChatId ? new Telegram(cfg.telegramToken, cfg.telegramChatId) : null;
  const summary = await runScan({ db, cfg, http, telegram, adapters, concurrency: 'concurrent', log: (s) => console.log(s) });
  return Response.json(summary);
}

export default getRequestListener(fetchHandler);
