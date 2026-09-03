import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.js';
import { openDb, ensureSchema } from '../core/db/index.js';
import { HttpClient } from '../core/http.js';
import { Telegram } from '../core/telegram.js';
import { adapters as allAdapters } from '../sources/index.js';
import { runScan } from '../core/run.js';
import { loadDotEnv } from './env.js';
import { selectSources } from './select-sources.js';

interface CliArgs {
  source: string | null;
  exclude: string | null;
  dryRun: boolean;
  noNotify: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { source: null, exclude: null, dryRun: false, noNotify: false };
  for (const arg of argv) {
    if (arg.startsWith('--source=')) args.source = arg.slice('--source='.length);
    else if (arg.startsWith('--exclude=')) args.exclude = arg.slice('--exclude='.length);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-notify') args.noNotify = true;
  }
  return args;
}

async function main(): Promise<void> {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  loadDotEnv(`${projectRoot}.env`, process.env);

  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig({ configPath: `${projectRoot}config/watch.yaml` });

  const db = openDb(cfg.databaseUrl, cfg.databaseAuthToken ?? undefined);
  await ensureSchema(db);

  const http = new HttpClient({
    minGapMs: cfg.scan.minRequestGapMs,
    hostGapOverrides: { 'last-minute.zajezdy.cz': 5000 },
  });

  // Select adapters: all by default, or a comma-separated subset via --source=
  // or the SCAN_SOURCES env var (the Mac fallback scanner uses SCAN_SOURCES to
  // scrape only the sources the cloud IP can't reach). --source= wins over env.
  // Then drop --exclude= / SCAN_EXCLUDE_SOURCES (CLI wins again): the cloud
  // workflow excludes the CESYS sources its datacenter IP never reaches (0/55,
  // 0/55, 0/56 successes over the 7 days to 2026-09-03), so it stops writing a
  // `failed` source_runs row every 2 h that only feeds the health alerts.
  const rawSources = args.source ?? process.env.SCAN_SOURCES ?? null;
  const rawExclude = args.exclude ?? process.env.SCAN_EXCLUDE_SOURCES ?? null;
  const { adapters, unknown, excluded } = selectSources(allAdapters, rawSources, rawExclude);
  const knownNames = allAdapters.map((a) => a.name).join(', ');
  if (unknown.length > 0) {
    console.warn(`Ignoring unknown source(s): ${unknown.join(', ')} — known: ${knownNames}`);
  }
  if (excluded.length > 0) {
    console.log(`Excluding source(s): ${excluded.join(', ')}`);
  }
  if (adapters.length === 0) {
    // Zero adapters is a misconfig either way — nothing matched, or the exclude
    // list swallowed everything that did. Name the actual cause.
    const cause = excluded.length > 0
      ? `every selected source is excluded (${excluded.join(', ')})`
      : `no known sources in "${rawSources}"`;
    console.error(`Nothing to scan: ${cause}. Known: ${knownNames}`);
    process.exit(1);
  }

  // Telegram only when both token and chatId are set; otherwise warn and behave
  // like a dry run for sends. --no-notify or --dry-run also suppress sends.
  let telegram: Telegram | null = null;
  if (cfg.telegramToken && cfg.telegramChatId) {
    telegram = new Telegram(cfg.telegramToken, cfg.telegramChatId);
  } else {
    console.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — running without notifications (dry-run for sends).');
  }

  const dryRun = args.dryRun || args.noNotify;

  const summary = await runScan({
    db,
    cfg,
    http,
    telegram,
    adapters,
    dryRun,
    log: (s) => console.log(s),
  });

  // Report.
  console.log('\n=== Scan summary ===');
  for (const s of summary.perSource) {
    const errPart = s.error ? ` — ${s.error}` : '';
    console.log(`  ${s.source}: ${s.status} (${s.offersFound} offers)${errPart}`);
  }
  console.log(`  notifications ${dryRun ? 'would send' : 'sent'}: ${summary.notificationsSent}`);
  console.log(`  digest ${dryRun ? 'would send' : 'sent'}: ${summary.digestSent}`);

  // Exit 1 only if every source failed; partial/ok → 0.
  const allFailed = summary.perSource.length > 0 && summary.perSource.every((s) => s.status === 'failed');
  process.exit(allFailed ? 1 : 0);
}

main().catch((err) => {
  console.error('Scan crashed:', err);
  process.exit(1);
});
