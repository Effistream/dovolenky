import { desc, eq, and, not, like } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { notificationsLog, offers, sourceRuns } from './db/schema.js';
import type { AppConfig } from './config.js';
import type { Telegram } from './telegram.js';
import type { NormalizedOffer, SourceAdapter } from './types.js';
import { ingestOffer, markMissedOffers, isPlaceholderTitle } from './ingest.js';
import { SourceBlockedError } from './http.js';
import { computeRealDiscount, type DiscountResult } from './discount.js';
import { matchProfiles } from './filters.js';
import { evaluateOffer, filterAgainstLog, recordSent, capMessages, groupCandidates, type Candidate } from './notify.js';
import { computeMatchKey } from './normalize.js';
import { formatOffer } from './format.js';
import { pragueDayString } from './dates.js';
import { hotelTermPricesPN, localityBucketPricesPN, marketBucketPrices, ownSnapshotsFor } from './market.js';
import { buildDigest } from './digest.js';
import { getExcludedCountries } from './db/exclusions.js';
import { BLOCKED_PREFIX, BACKOFF_MARKER, RECENT_RUN_SCAN_LIMIT, isBackoffRow, backoffUntilFrom } from './backoff.js';

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
  excluded: Set<string>,
): Promise<OfferProcessResult> {
  const candidates: Candidate[] = [];
  let snapshotsWritten = 0;
  let errored = 0;

  for (const offer of sourceOffers) {
    try {
      const ingest = await ingestOffer(db, offer, now);
      if (ingest.snapshotWritten) snapshotsWritten += 1;

      // Scan-time keys must match persisted keys (2026-07-07 fix): ingestOffer persists
      // match_key/hotel_key computed from the STICKY-GUARDED title (see ingest.ts), so a
      // placeholder incoming title (e.g. dovolenkovani's "Hotel 320645") does NOT overwrite an
      // already-resolved real title in the DB. If we fed the raw incoming `offer` (still carrying
      // the placeholder title) into computeMatchKey/computeHotelKey and the bucket queries below,
      // our scan-time keys would diverge from the persisted ones — thinning the hotel pool and
      // letting twin-exclusion miss, which can under-notify (a lower reference tier than the
      // dashboard, which reads persisted keys, shows). Building `keyOffer` from
      // ingest.persistedTitle keeps the two in lockstep.
      const keyOffer = ingest.persistedTitle === offer.title ? offer : { ...offer, title: ingest.persistedTitle };

      const ownSnapshots = await ownSnapshotsFor(db, ingest.offerId, now);
      // Per-night reference ladder (spec §15): hotel → locality → market, each a
      // per-night bucket; discount.ts picks the first that qualifies (own/omnibus
      // still win above them). `nights` is required for the per-night tiers.
      const hotelPricesPN = await hotelTermPricesPN(db, ingest.offerId, keyOffer);
      const localityPricesPN = await localityBucketPricesPN(db, ingest.offerId, keyOffer);
      const marketPricesPN = await marketBucketPrices(db, ingest.offerId, keyOffer);

      const discount: DiscountResult = computeRealDiscount({
        current: offer.pricePerPerson,
        ownSnapshots,
        omnibus: offer.omnibusLowestPrice,
        nights: offer.nights,
        hotelTermPricesPN: hotelPricesPN,
        localityPricesPN,
        marketPricesPN,
        claimedPct: offer.claimedDiscountPct,
        now,
      });

      // Global negative filter (Task 43): mute notifications for excluded countries.
      // The ingest/snapshot write ABOVE this line has already run, so an excluded
      // offer keeps its price history — only candidate generation is suppressed here.
      const isExcluded = offer.country != null && excluded.has(offer.country);
      const matches = isExcluded ? [] : matchProfiles(offer, cfg.profiles, now);
      const outcomes = evaluateOffer({
        offerId: ingest.offerId,
        offer,
        isNew: ingest.isNew,
        previousPrice: ingest.previousPrice,
        discount,
        matches,
        cfg: cfg.notifications,
      });

      // ingestOffer already persisted the match_key (from the sticky-guarded title); recompute
      // here from keyOffer (pure, no DB round-trip) — NOT the raw incoming `offer` — so the
      // candidate carries the exact same value the DB has, for grouping + log dedup.
      const matchKey = computeMatchKey(keyOffer);
      for (const outcome of outcomes) {
        candidates.push({
          offerId: ingest.offerId,
          offer,
          discount,
          type: outcome.type,
          profile: outcome.profile,
          previousPrice: ingest.previousPrice,
          matchKey,
          alternatives: [],
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
  // Pull a generous window and drop the benign backoff-skip bookkeeping rows: a persistently
  // blocked source alternates failed / backoff-partial rows, so counting raw rows would break the
  // consecutive-failure chain and the alert would NEVER fire (I2 defect). The chain is computed
  // over REAL runs only; index 0 of the filtered sequence = current run just written.
  const rows = await db
    .select({ status: sourceRuns.status, errorSample: sourceRuns.errorSample })
    .from(sourceRuns)
    .where(eq(sourceRuns.source, source))
    .orderBy(desc(sourceRuns.id))
    .limit(RECENT_RUN_SCAN_LIMIT);
  const recent = rows.filter((r) => !isBackoffRow(r.errorSample));

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
  excluded: Set<string>,
): Promise<boolean> {
  // Intl can format midnight as "24" instead of "0" depending on locale/runtime; normalize
  // (mirrors the same defense in zajezdy.ts's zajezdyAllowedNow).
  const pragueHour =
    Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', hour12: false }).format(now),
    ) % 24;
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

  const digest = await buildDigest(db, cfg, now, excluded);
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

/**
 * 24h backoff after a block (spec §9): finds the most recent REAL run (skipping the benign
 * backoff-skip bookkeeping rows this very mechanism inserts — otherwise a persistently blocked
 * source would see its own backoff row, decide there's no active block, and re-hammer the source
 * every ~4h; I2 defect). If that first non-backoff run ended 'failed' with a BLOCKED: error_sample
 * within the last BACKOFF_MS, returns the ISO time the backoff lifts so the caller can skip the
 * source this run; otherwise null (run normally). Delegates the pure decision to
 * backoff.ts#backoffUntilFrom (shared with the /api/sources backoff flag).
 */
async function blockedBackoffUntil(db: Db, source: string, now: Date): Promise<string | null> {
  const recent = await db
    .select({ status: sourceRuns.status, startedAt: sourceRuns.startedAt, errorSample: sourceRuns.errorSample })
    .from(sourceRuns)
    .where(eq(sourceRuns.source, source))
    .orderBy(desc(sourceRuns.id))
    .limit(RECENT_RUN_SCAN_LIMIT);

  const liftsAt = backoffUntilFrom(recent, now.getTime());
  return liftsAt != null ? new Date(liftsAt).toISOString() : null;
}

/**
 * Loads a sourceOfferKey -> title map for every currently-stored offer of `source` whose title
 * is NOT a placeholder (see ingest.ts#isPlaceholderTitle), fed to the adapter as
 * `ctx.priorTitles` (2026-07-07 fix). Lets an adapter (e.g. dovolenkovani.ts) skip re-resolving a
 * hotel/property name it already knows from a previous run, so its per-run resolution cap is
 * spent only on genuinely-new hotels rather than being re-consumed every run by hotels that
 * happen to fall outside the cap this time. One cheap indexed query per source per run; adapters
 * that don't use it (all but dovolenkovani, currently) pay a negligible, unused query cost.
 */
async function loadPriorTitles(db: Db, source: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ sourceOfferKey: offers.sourceOfferKey, title: offers.title })
    .from(offers)
    .where(and(eq(offers.source, source), not(like(offers.title, 'Hotel %'))));

  const map = new Map<string, string>();
  for (const row of rows) {
    if (isPlaceholderTitle(row.title)) continue; // belt-and-braces: LIKE is a coarse pre-filter
    map.set(row.sourceOfferKey, row.title);
  }
  return map;
}

export async function runScan(deps: RunScanDeps): Promise<ScanSummary> {
  const { db, cfg, telegram, adapters } = deps;
  const now = deps.now ?? new Date();
  const log = deps.log ?? (() => {});
  const dryRun = deps.dryRun ?? false;

  const perSource: SourceSummary[] = [];
  const allCandidates: Candidate[] = [];

  // Global negative filter (Task 43): read the excluded-country set ONCE per scan and
  // thread it through both muting choke points — per-offer candidate generation
  // (processOffers) and the daily digest (buildDigest via maybeSendDigest). Excluded
  // offers are still ingested (price history preserved); only their notifications are muted.
  const excluded = new Set(await getExcludedCountries(db));

  // --- Per-source scan (sequential; shared HttpClient handles politeness) ---
  for (const adapter of adapters) {
    const startedAt = now.toISOString();
    let status: 'ok' | 'partial' | 'failed';
    let offersFound = 0;
    let snapshotsWritten = 0;
    let errorCount = 0;
    let errorSample: string | null = null;
    let errorMessage: string | undefined;

    // 24h backoff after a block (spec §9): skip the source entirely (no adapter call) while a
    // recent block is still cooling off; record a benign 'partial'/backoff run so history stays
    // continuous and this doesn't count toward the 3×-failed health alert.
    const backoffUntil = await blockedBackoffUntil(db, adapter.name, now);
    if (backoffUntil) {
      log(`source ${adapter.name}: backoff po blokaci, přeskakuji do ${backoffUntil}`);
      await db.insert(sourceRuns).values({
        source: adapter.name,
        startedAt,
        finishedAt: now.toISOString(),
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 0,
        status: 'partial',
        errorSample: BACKOFF_MARKER,
      });
      perSource.push({ source: adapter.name, status: 'partial', offersFound: 0 });
      continue;
    }

    try {
      const priorTitles = await loadPriorTitles(db, adapter.name);
      const fetched = await adapter.fetchOffers({ http: deps.http, adults: cfg.scan.adults, log, priorTitles });
      offersFound = fetched.length;

      const processed = await processOffers(db, cfg, fetched, now, log, excluded);
      allCandidates.push(...processed.candidates);
      snapshotsWritten = processed.snapshotsWritten;
      errorCount = processed.errored;

      if (offersFound === 0) {
        // Zero offers from a listing/discovery adapter never means "the market is empty" — it
        // means we saw nothing this run (intentional skip like zajezdy's crawl window, an empty
        // page, or a swallowed partial failure). Treat it as 'partial' and, crucially, SKIP
        // markMissedOffers: otherwise a couple of empty runs would flip the whole source's
        // inventory inactive (C1/C2). Real disappearances are detected against non-empty runs.
        status = 'partial';
        errorSample = 'zero offers returned — skipping markMissedOffers';
        log(`source ${adapter.name}: 0 offers returned, skipping markMissedOffers`);
      } else {
        if (processed.errored > 0) {
          status = 'partial';
          errorSample = `${processed.errored} offer(s) failed processing`;
        } else {
          status = 'ok';
        }

        // Skip markMissedOffers on dry runs: the ingest/snapshot writes above are useful history
        // to collect, but flipping offers missed/inactive is a harmful side effect for a dry run
        // (spec / README: --dry-run neoznačuje zmizelé nabídky).
        if (!dryRun) {
          await markMissedOffers(db, adapter.name, fetched.map((o) => o.sourceOfferKey), now);
        }
      }
    } catch (err) {
      status = 'failed';
      errorCount = 1;
      errorMessage = (err as Error).message;
      // Mark blocks distinctly so the 24h backoff can recognize them on the next run.
      errorSample = err instanceof SourceBlockedError ? `${BLOCKED_PREFIX}${errorMessage}` : errorMessage;
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
  // Cross-source dedup (spec §13): group same-match_key candidates into one
  // representative (cheapest, carrying the pricier peers as `alternatives`)
  // BEFORE the log dedup, so it's the representative — as the group — that gets
  // checked against notifications_log and, once sent, records the match_key.
  const grouped = groupCandidates(allCandidates);
  const eligible = await filterAgainstLog(db, grouped, cfg.notifications, now);
  const { send, overflow } = capMessages(eligible, cfg.notifications.maxMessagesPerRun);

  let notificationsSent = 0;
  for (const candidate of send) {
    // formatOffer renders the price_drop "↓ z …" line only when given a
    // previousPrice, and omits it otherwise (e.g. hot_deal/new_offer); the
    // "Také: …" alternatives line renders only when the group had peers.
    const html = formatOffer(candidate.type, candidate.offer, candidate.discount, {
      previousPrice: candidate.previousPrice ?? undefined,
      alternatives: candidate.alternatives,
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
  const digestSent = await maybeSendDigest(db, cfg, now, telegram, dryRun, excluded);

  // --- Health alerts (per source whose current run failed) ---
  for (const s of perSource) {
    if (s.status === 'failed') {
      await maybeSendHealthAlert(db, s.source, telegram, dryRun);
    }
  }

  return { perSource, notificationsSent, digestSent };
}
