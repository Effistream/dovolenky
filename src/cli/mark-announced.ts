import { fileURLToPath } from 'node:url';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { loadConfig } from '../core/config.js';
import { openDb, ensureSchema } from '../core/db/index.js';
import { notificationsLog, offers, priceSnapshots } from '../core/db/schema.js';
import { loadDotEnv } from './env.js';

/**
 * One-off maintenance: mark every currently-active offer as ALREADY ANNOUNCED, by writing the
 * new_offer notifications_log row a real send would have written — without sending anything.
 *
 * WHY THIS EXISTS. new_offer is suppressed by a log row (notify.ts#shouldSend), and an offer stays
 * new_offer-eligible for NEW_OFFER_ELIGIBLE_MS after first_seen_at (run.ts). run.ts's re-key flood
 * guard normally writes these rows itself whenever an adapter's sourceOfferKey definition changes,
 * so a re-keyed inventory never gets announced as news. But if a scan lands BEFORE that guard is
 * deployed (as happened on 2026-07-29: the Mac fallback ran the new adapters at 12:40 while the
 * guard was still uncommitted), thousands of re-keyed offers sit in the DB with a fresh
 * first_seen_at and no log row — and every later scan would announce them, 20 per run, for days.
 *
 * Running this once closes that window. Offers discovered AFTER it still notify normally.
 *
 *   npx tsx src/cli/mark-announced.ts [--dry-run]
 */

const CHUNK = 100;

async function main(): Promise<void> {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  loadDotEnv(`${projectRoot}.env`, process.env);
  const dryRun = process.argv.slice(2).includes('--dry-run');

  const cfg = loadConfig({ configPath: `${projectRoot}config/watch.yaml` });
  const db = openDb(cfg.databaseUrl, cfg.databaseAuthToken ?? undefined);
  await ensureSchema(db);

  // Active offers with no new_offer log row yet, plus their latest price (for priceAtSend, so the
  // row is indistinguishable from one a real send would have written).
  const latest = db
    .select({ offerId: priceSnapshots.offerId, maxId: sql<number>`max(${priceSnapshots.id})`.as('max_id') })
    .from(priceSnapshots)
    .groupBy(priceSnapshots.offerId)
    .as('latest');

  const rows = await db
    .select({
      id: offers.id,
      matchKey: offers.matchKey,
      price: priceSnapshots.pricePerPerson,
      logged: notificationsLog.id,
    })
    .from(offers)
    .leftJoin(latest, eq(latest.offerId, offers.id))
    .leftJoin(priceSnapshots, eq(priceSnapshots.id, latest.maxId))
    .leftJoin(
      notificationsLog,
      and(eq(notificationsLog.offerId, offers.id), eq(notificationsLog.type, 'new_offer')),
    )
    .where(and(eq(offers.active, true), isNull(notificationsLog.id)));

  console.log(`active offers without a new_offer log row: ${rows.length}`);
  if (dryRun) {
    console.log('--dry-run: nothing written');
    process.exit(0);
  }
  if (rows.length === 0) {
    console.log('nothing to do');
    process.exit(0);
  }

  const nowIso = new Date().toISOString();
  const values = rows.map((r) => ({
    offerId: r.id,
    type: 'new_offer' as const,
    sentAt: nowIso,
    sent: false, // recorded as accounted for, never messaged
    priceAtSend: r.price ?? null,
    matchKey: r.matchKey,
  }));

  for (let i = 0; i < values.length; i += CHUNK) {
    await db.insert(notificationsLog).values(values.slice(i, i + CHUNK));
    process.stdout.write(`\rmarked ${Math.min(i + CHUNK, values.length)}/${values.length}`);
  }
  console.log(`\ndone — ${values.length} offers marked announced (no messages sent)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('mark-announced failed:', err);
  process.exit(1);
});
