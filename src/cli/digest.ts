import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.js';
import { openDb, ensureSchema } from '../core/db/index.js';
import { notificationsLog } from '../core/db/schema.js';
import { Telegram } from '../core/telegram.js';
import { buildDigest } from '../core/digest.js';
import { getExcludedCountries } from '../core/db/exclusions.js';
import { loadDotEnv } from './env.js';

interface CliArgs {
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function main(): Promise<void> {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  loadDotEnv(`${projectRoot}.env`, process.env);

  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig({ configPath: `${projectRoot}config/watch.yaml` });

  const db = openDb(cfg.databaseUrl);
  await ensureSchema(db);

  // Manual invocation: build the digest right now, ignoring the digestHour /
  // once-per-Prague-day gating that runScan applies automatically.
  const now = new Date();
  // Respect the global negative filter here too: a manually-sent digest mutes
  // the same excluded countries as the automatic one (ingest is untouched).
  const excluded = new Set(await getExcludedCountries(db));
  const digest = await buildDigest(db, cfg, now, excluded);

  if (!digest) {
    console.log('Žádné aktivní nabídky — digest by byl prázdný, nic se neposílá.');
    process.exit(0);
  }

  let telegram: Telegram | null = null;
  if (cfg.telegramToken && cfg.telegramChatId) {
    telegram = new Telegram(cfg.telegramToken, cfg.telegramChatId);
  }

  if (args.dryRun || !telegram) {
    if (!args.dryRun) {
      console.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — printing digest instead of sending.');
    }
    console.log(digest.html);
    console.log(`\n(${digest.itemCount} položek)`);
    process.exit(0);
  }

  await telegram.send(digest.html);
  await db.insert(notificationsLog).values({
    offerId: null,
    type: 'digest',
    sentAt: now.toISOString(),
    priceAtSend: null,
  });

  console.log(`Digest odeslán (${digest.itemCount} položek).`);
}

main().catch((err) => {
  console.error('Digest crashed:', err);
  process.exit(1);
});
