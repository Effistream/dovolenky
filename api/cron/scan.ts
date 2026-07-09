import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { HttpClient } from '../../src/core/http.js';
import { Telegram } from '../../src/core/telegram.js';
import { adapters } from '../../src/sources/index.js';
import { runScan } from '../../src/core/run.js';
import { checkCronSecret } from '../../src/web/cron-auth.js';
import { bootstrap } from '../_lib/bootstrap.js';

const { db, cfg } = await bootstrap();
const app = new Hono();
app.get('/api/cron/scan', async (c) => {
  if (!checkCronSecret(c.req.header('authorization'), process.env.CRON_SECRET)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const http = new HttpClient({ minGapMs: cfg.scan.minRequestGapMs, hostGapOverrides: { 'last-minute.zajezdy.cz': 5000 } });
  const telegram = cfg.telegramToken && cfg.telegramChatId ? new Telegram(cfg.telegramToken, cfg.telegramChatId) : null;
  const summary = await runScan({ db, cfg, http, telegram, adapters, concurrency: 'concurrent', log: (s) => console.log(s) });
  return c.json(summary);
});
export default handle(app);
