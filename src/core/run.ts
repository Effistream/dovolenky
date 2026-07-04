import { desc, eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { notificationsLog, sourceRuns } from './db/schema.js';
import type { AppConfig } from './config.js';
import type { Telegram } from './telegram.js';
import type { NormalizedOffer, SourceAdapter } from './types.js';
import { ingestOffer, markMissedOffers } from './ingest.js';
import { computeRealDiscount, type DiscountResult } from './discount.js';
import { matchProfiles } from './filters.js';
import { evaluateOffer, filterAgainstLog, recordSent, capMessages, type Candidate } from './notify.js';
import { formatOffer } from './format.js';
import { pragueDayString } from './dates.js';
import { marketBucketPrices, ownSnapshotsFor } from './market.js';
import { buildDigest } from './digest.js';

export interface RunScanDeps {
  db: Db;
  cfg: AppConfig;
  http: import('./http.js').HttpClient;
  telegram: Telegram | null;
  adapters: SourceAdapter[];
  now?: Date;
  log?: (s: string) => void;
  dryRun?: boolean;
}

export interface SourceSummary {
  source: string;
  status: 'ok' | 'partial' | 'failed';
  offersFound: number;
  error?: string;
}

export interface ScanSummary {
  perSource: SourceSummary[];
  notificationsSent: number;
  digestSent: boolean;
}

interface OfferProcessResult {
  candidates: Candidate[];
  snapshotsWritten: number;
  errored: number;
}

/** Runs the per-offer pipeline for one source's offers, isolating per-offer errors. */
async function processOffers(
  db: Db,
  cfg: AppConfig,
  sourceOffers: NormalizedOffer[],
  now: Date,
  log: (s: string) => void,
): Promise<OfferProcessResult> {
  const candidates: Candidate[] = [];
  let snapshotsWritten = 0;
  let errored = 0;

  for (const offer of sourceOffers) {
    try {
      const ingest = await ingestOffer(db, offer, now);
      if (ingest.snapshotWritten) snapshotsWritten += 1;

      const ownSnapshots = await ownSnapshotsFor(db, ingest.offerId, now);
      const marketPrices = await marketBucketPrices(db, ingest.offerId, offer);

      const discount: DiscountResult = computeRealDiscount({
        current: offer.pricePerPerson,
        ownSnapshots,
        omnibus: offer.omnibusLowestPrice,
        marketPrices,
        claimedPct: offer.claimedDiscountPct,
        now,
      });

      const matches = matchProfiles(offer, cfg.profiles, now);
      const outcomes = evaluateOffer({
        offerId: ingest.offerId,
        offer,
        isNew: ingest.isNew,
        previousPrice: ingest.previousPrice,
        discount,
        matches,
        cfg: cfg.notifications,
      });

      for (const outcome of outcomes) {
        candidates.push({
          offerId: ingest.offerId,
          offer,
          discount,
          type: outcome.type,
          profile: outcome.profile,
          previousPrice: ingest.previousPrice,
        });
      }
    } catch (err) {
      errored += 1;
      log(`offer error (${offer.source}/${offer.sourceOfferKey}): ${(err as Error).message}`);
    }
  }

  return { candidates, snapshotsWritten, errored };
}

/**
 * Health alerts (spec §10): a source that has failed 3 runs in a row triggers a
 * single 🛠 alert — only on the 2→3 transition. Precisely, alert iff the current
 * run failed AND the previous two runs failed AND the run before those did NOT
 * fail (absent rows count as success). The current run's row must already be
 * written before calling this.
 */
async function maybeSendHealthAlert(
  db: Db,
  source: string,
  telegram: Telegram | null,
  dryRun: boolean,
): Promise<boolean> {
  // Most recent 4 runs for this source (index 0 = current run just written).
  const recent = await db
    .select({ status: sourceRuns.status })
    .from(sourceRuns)
    .where(eq(sourceRuns.source, source))
    .orderBy(desc(sourceRuns.id))
    .limit(4);

  const failedAt = (i: number): boolean => recent[i]?.status === 'failed';
  const succeededAt = (i: number): boolean => !failedAt(i); // absent counts as success

  const shouldAlert = failedAt(0) && failedAt(1) && failedAt(2) && succeededAt(3);
  if (!shouldAlert) return false;

  if (!dryRun && telegram) {
    await telegram.send(`🛠 Zdroj <b>${source}</b> selhal 3× v řadě — scraper může být rozbitý.`);
  }
  return true;
}

/**
 * Digest gating (spec §7): sends the daily digest iff the current Prague hour
 * ≥ digestHour AND no digest was logged for today's Prague day yet. Data
 * assembly + formatting lives in core/digest.ts (buildDigest); this function
 * only gates, sends, and records the send.
 */
async function maybeSendDigest(
  db: Db,
  cfg: AppConfig,
  now: Date,
  telegram: Telegram | null,
  dryRun: boolean,
): Promise<boolean> {
  const pragueHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', hour12: false }).format(now),
  );
  if (pragueHour < cfg.notifications.digestHour) return false;

  const today = pragueDayString(now);

  // Already sent a digest today?
  const [lastDigest] = await db
    .select({ sentAt: notificationsLog.sentAt })
    .from(notificationsLog)
    .where(eq(notificationsLog.type, 'digest'))
    .orderBy(desc(notificationsLog.id))
    .limit(1);
  if (lastDigest && pragueDayString(new Date(lastDigest.sentAt)) >= today) return false;

  const digest = await buildDigest(db, cfg, now);
  if (!digest) return false;

  // A null telegram is treated like a dry run for sends: report that a digest
  // *would* be sent, but neither transmit nor log it (only real sends persist).
  if (!dryRun && telegram) {
    await telegram.send(digest.html);
    await db.insert(notificationsLog).values({
      offerId: null,
      type: 'digest',
      sentAt: now.toISOString(),
      priceAtSend: null,
    });
  }

  return true;
}

export async function runScan(deps: RunScanDeps): Promise<ScanSummary> {
  const { db, cfg, telegram, adapters } = deps;
  const now = deps.now ?? new Date();
  const log = deps.log ?? (() => {});
  const dryRun = deps.dryRun ?? false;

  const perSource: SourceSummary[] = [];
  const allCandidates: Candidate[] = [];

  // --- Per-source scan (sequential; shared HttpClient handles politeness) ---
  for (const adapter of adapters) {
    const startedAt = now.toISOString();
    let status: 'ok' | 'partial' | 'failed';
    let offersFound = 0;
    let snapshotsWritten = 0;
    let errorCount = 0;
    let errorSample: string | null = null;
    let errorMessage: string | undefined;

    try {
      const fetched = await adapter.fetchOffers({ http: deps.http, adults: cfg.scan.adults, log });
      offersFound = fetched.length;

      const processed = await processOffers(db, cfg, fetched, now, log);
      allCandidates.push(...processed.candidates);
      snapshotsWritten = processed.snapshotsWritten;
      errorCount = processed.errored;

      if (processed.errored > 0) {
        status = 'partial';
        errorSample = `${processed.errored} offer(s) failed processing`;
      } else {
        status = 'ok';
      }

      await markMissedOffers(db, adapter.name, fetched.map((o) => o.sourceOfferKey), now);
    } catch (err) {
      status = 'failed';
      errorCount = 1;
      errorMessage = (err as Error).message;
      errorSample = errorMessage;
      log(`source ${adapter.name} failed: ${errorMessage}`);
    }

    await db.insert(sourceRuns).values({
      source: adapter.name,
      startedAt,
      finishedAt: now.toISOString(),
      offersFound,
      snapshotsWritten,
      errorCount,
      status,
      errorSample,
    });

    perSource.push({ source: adapter.name, status, offersFound, error: errorMessage });
  }

  // --- Notifications ---
  const eligible = await filterAgainstLog(db, allCandidates, cfg.notifications, now);
  const { send, overflow } = capMessages(eligible, cfg.notifications.maxMessagesPerRun);

  let notificationsSent = 0;
  for (const candidate of send) {
    // formatOffer renders the price_drop "↓ z …" line only when given a
    // previousPrice, and omits it otherwise (e.g. hot_deal/new_offer).
    const html = formatOffer(candidate.type, candidate.offer, candidate.discount, {
      previousPrice: candidate.previousPrice ?? undefined,
    });

    if (!dryRun && telegram) {
      await telegram.send(html);
      await recordSent(db, candidate, now);
    }
    notificationsSent += 1;
  }

  if (overflow > 0 && !dryRun && telegram) {
    await telegram.send(`… a dalších ${overflow} nabídek splnilo podmínky.`);
  }

  // --- Digest ---
  const digestSent = await maybeSendDigest(db, cfg, now, telegram, dryRun);

  // --- Health alerts (per source whose current run failed) ---
  for (const s of perSource) {
    if (s.status === 'failed') {
      await maybeSendHealthAlert(db, s.source, telegram, dryRun);
    }
  }

  return { perSource, notificationsSent, digestSent };
}
