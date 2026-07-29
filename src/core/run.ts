import { desc, eq, and, not, like } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { notificationsLog, offers, sourceRuns } from './db/schema.js';
import type { AppConfig } from './config.js';
import type { Telegram } from './telegram.js';
import type { NormalizedOffer, SourceAdapter } from './types.js';
import { ingestSourceOffers, markMissedOffers, isPlaceholderTitle } from './ingest.js';
import { SourceBlockedError } from './http.js';
import { computeRealDiscount, type DiscountResult } from './discount.js';
import { matchProfiles } from './filters.js';
import { evaluateOffer, filterAgainstLog, recordSent, capMessages, groupCandidates, collapseTypes, type Candidate } from './notify.js';
import { computeMatchKey } from './normalize.js';
import { formatOffer } from './format.js';
import { pragueDayString } from './dates.js';
import { bucketPricesInMemory, loadBucketContext, ownSnapshotsFor, type BucketContext } from './market.js';
import { buildDigest } from './digest.js';
import { getExcludedCountries } from './db/exclusions.js';
import { BLOCKED_PREFIX, BACKOFF_MARKER, RECENT_RUN_SCAN_LIMIT, isBackoffRow, backoffUntilFrom } from './backoff.js';

/** The "no reference could be computed" discount, used for offers whose discount is skipped
 * because they match no watch profile (so it can never drive a notification). */
const NO_DISCOUNT: DiscountResult = { realPct: null, reference: null, baseline: null, fake: false };

/**
 * How long after first_seen_at an offer can still produce a new_offer notification.
 *
 * Gating on ingest's one-shot `isNew` made an overflowing new_offer unrecoverable: the per-run
 * message cap dropped it, nothing was logged, and `isNew` never came back — 58% of all eligible
 * new offers were never sent (audit 2026-07-29). Keeping eligibility open for a window turns the
 * cap into a DELAY instead of a loss; notify.ts#shouldSend still enforces at-most-once via the
 * notifications_log row. 3 days covers a weekend of GitHub-cron hiccups (observed gaps up to
 * 4.5h) without resurrecting offers so old they are no longer "new".
 */
const NEW_OFFER_ELIGIBLE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Re-key flood thresholds (see the guard in processOffers). Normal operation adds a handful of
 * genuinely new offers per source per run; a source where most of a large harvest is new has had
 * its identity definition changed (or is being scanned for the first time), which is bookkeeping,
 * not news. Deliberately conservative — a real burst of 30+ offers that is also ≥60% of the
 * source would be indistinguishable from a re-key anyway, and suppressing new_offer for one run
 * costs nothing: the offers stay on the board and remain eligible once the source settles.
 */
const REKEY_FLOOD_MIN_OFFERS = 30;
const REKEY_FLOOD_SHARE = 0.6;
/** Rows per notifications_log insert when marking a flood announced (bounded round-trips). */
const NOTIFICATION_LOG_CHUNK = 100;

/** True while an offer is still inside the new_offer window (brand-new offers always qualify). */
function isNewOfferEligible(ingest: { isNew: boolean; firstSeenAt: string }, now: Date): boolean {
  if (ingest.isNew) return true;
  const firstSeen = new Date(ingest.firstSeenAt).getTime();
  if (!Number.isFinite(firstSeen)) return false;
  return now.getTime() - firstSeen <= NEW_OFFER_ELIGIBLE_MS;
}

/**
 * Overall wall-clock ceiling for a single adapter's fetchOffers. The per-request 25s HttpClient
 * timeout bounds one request, but an adapter that makes many requests to a host that tarpits our
 * IP (some sites do this to datacenter IPs like a GitHub Actions runner) would still take
 * minutes — and since the fetch phase runs all adapters concurrently, one such adapter would
 * stall the whole scan. This caps each adapter: on timeout its fetch is abandoned and that source
 * is recorded 'failed', while every responsive source completes normally.
 *
 * Sized against the per-adapter REQUEST BUDGET (see docs/audits/2026-07-29): adapters paginate to
 * at most ~40 requests, and HttpClient enforces a 3s per-host gap, so a legit worst case is
 * ~40 × (3s gap + ~1s fetch) ≈ 160s. 240s leaves margin for a slow-but-alive host without letting
 * a tarpitting one stall the concurrent fetch phase. The whole scan is bounded by the SLOWEST
 * adapter (they run concurrently), so this also bounds scan wall-clock — comfortably inside the
 * GitHub Actions job's 30min timeout.
 */
const ADAPTER_FETCH_TIMEOUT_MS = 240000;

/** Reject with an Error after `ms` if `p` hasn't settled. Does not cancel `p` (its in-flight
 * requests still settle via their own per-request timeout); the caller just stops waiting. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: fetch exceeded ${ms}ms budget`)), ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export interface RunScanDeps {
  db: Db;
  cfg: AppConfig;
  http: import('./http.js').HttpClient;
  telegram: Telegram | null;
  adapters: SourceAdapter[];
  now?: Date;
  log?: (s: string) => void;
  dryRun?: boolean;
  /**
   * Fetch-phase dispatch (Task 47). 'concurrent' (default) runs every adapter's fetchOffers in
   * parallel so the whole scan fits a serverless time budget (~90s, bounded by the slowest single
   * adapter) instead of ~12min of summed per-host politeness gaps; 'sequential' runs them one at a
   * time. Only the FETCH phase differs — the processing phase (ingest/snapshot/sourceRuns writes,
   * markMissedOffers, candidate collection) is always sequential in `adapters` order, so both modes
   * produce identical per-source results. Per-host politeness is preserved in either mode by the
   * shared HttpClient's per-host request serialization; no throttling is added here.
   */
  concurrency?: 'sequential' | 'concurrent';
  /** Per-adapter fetch timeout override (ms). Defaults to ADAPTER_FETCH_TIMEOUT_MS. Injectable so
   * tests can use a small value without waiting out the real budget. */
  adapterTimeoutMs?: number;
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
  dryRun: boolean,
): Promise<OfferProcessResult> {
  const candidates: Candidate[] = [];
  let snapshotsWritten = 0;
  let errored = 0;

  // Batch the entire ingest/snapshot write path for this source into a handful of round-trips
  // (ingestSourceOffers) instead of ~5 per offer — the dominant scan-time cost against a remote
  // (Turso) DB. Results are ALIGNED with sourceOffers by index (ingestResults[i] ↔ sourceOffers[i]).
  // This runs OUTSIDE the per-offer try/catch on purpose: if the batch write throws, the whole
  // source fails and funnels to runScan's catch (status 'failed') — which matches the pre-batch
  // "every offer errored" outcome for a DB-wide failure. The per-offer loop keeps its own try/catch
  // to isolate the read-only discount/candidate work exactly as before.
  const ingestResults = await ingestSourceOffers(db, sourceOffers, now);

  // RE-KEY FLOOD GUARD. new_offer fires on identity, and an offer's identity is
  // offerKeyHash(...) over adapter-chosen fields. Whenever an adapter's key definition changes
  // (the 2026-07-29 coverage work re-keyed invia/deluxea/eximtours/esotravel/firo/dovolenkovani),
  // every stored offer of that source arrives as "brand new" at once — hundreds of them. The same
  // happens on a brand-new source's first scan. Neither is a discovery worth notifying, and with
  // new_offer eligibility now lasting 3 days the burst would repeat every run for days.
  // So: if a source's harvest is overwhelmingly new AND large, we ingest normally but emit NO
  // new_offer for it this run. hot_deal/price_drop are unaffected — a re-keyed offer with a real
  // discount still deserves an alert, and those are self-limiting via the log + cap.
  const newCount = ingestResults.filter((r) => r.isNew).length;
  const isRekeyFlood =
    newCount >= REKEY_FLOOD_MIN_OFFERS && newCount / ingestResults.length >= REKEY_FLOOD_SHARE;
  if (isRekeyFlood) {
    log(
      `source ${sourceOffers[0]?.source ?? '?'}: ${newCount}/${ingestResults.length} offers are new — ` +
        `treating as a re-key/first-scan flood, marking them announced without sending`,
    );
    // Marking them ANNOUNCED (a log row, no Telegram send) rather than merely skipping this run:
    // these offers stay new_offer-eligible for 3 days, so a one-run skip would just postpone the
    // burst to the next scan. The log row is what makes shouldSend return false for good — the
    // same mechanism a real send uses. Written only for a real run; a dry run must not mutate the
    // notification history.
    if (!dryRun) {
      const rows = ingestResults
        .map((r, i) => ({ r, offer: sourceOffers[i]! }))
        .filter(({ r }) => r.isNew)
        .map(({ r, offer }) => ({
          offerId: r.offerId,
          type: 'new_offer' as const,
          sentAt: now.toISOString(),
          // Recorded, not sent — see the `sent` column on notifications_log.
          sent: false,
          priceAtSend: offer.pricePerPerson,
          matchKey: computeMatchKey(
            r.persistedTitle === offer.title ? offer : { ...offer, title: r.persistedTitle },
          ),
        }));
      for (let i = 0; i < rows.length; i += NOTIFICATION_LOG_CHUNK) {
        await db.insert(notificationsLog).values(rows.slice(i, i + NOTIFICATION_LOG_CHUNK));
      }
    }
  }

  // In-memory bucket context for the reference ladder, loaded lazily on the FIRST
  // profile-matching offer (sources whose offers match no profile pay nothing) and
  // reused for every candidate of this source. Loaded after the ingest above, so it
  // sees this source's fresh prices — the same state the per-candidate SQL bucket
  // queries used to read.
  let bucketCtx: BucketContext | null = null;

  for (let i = 0; i < sourceOffers.length; i += 1) {
    const offer = sourceOffers[i]!;
    const ingest = ingestResults[i]!;
    try {
      if (ingest.snapshotWritten) snapshotsWritten += 1;

      // Scan-time keys must match persisted keys (2026-07-07 fix): ingestSourceOffers persists
      // match_key/hotel_key computed from the STICKY-GUARDED title (see ingest.ts), so a
      // placeholder incoming title (e.g. dovolenkovani's "Hotel 320645") does NOT overwrite an
      // already-resolved real title in the DB. If we fed the raw incoming `offer` (still carrying
      // the placeholder title) into computeMatchKey/computeHotelKey and the bucket queries below,
      // our scan-time keys would diverge from the persisted ones — thinning the hotel pool and
      // letting twin-exclusion miss, which can under-notify (a lower reference tier than the
      // dashboard, which reads persisted keys, shows). Building `keyOffer` from
      // ingest.persistedTitle keeps the two in lockstep.
      const keyOffer = ingest.persistedTitle === offer.title ? offer : { ...offer, title: ingest.persistedTitle };

      // Global negative filter (Task 43): mute notifications for excluded countries.
      // The ingest/snapshot write ABOVE this line has already run, so an excluded
      // offer keeps its price history — only candidate generation is suppressed here.
      const isExcluded = offer.country != null && excluded.has(offer.country);
      const matches = isExcluded ? [] : matchProfiles(offer, cfg.profiles, now);

      // The per-night reference ladder (spec §15) is ONLY consumed to decide
      // hot_deal/price_drop/new_offer notifications, and every notification type requires a
      // matched profile (evaluateOffer → strongestMatch returns null on empty matches). So for
      // the vast majority of offers — which match no watch profile — computing the discount is
      // pure waste: it can never produce a candidate (discount-gating). For the offers that DO
      // match, the buckets are computed IN MEMORY over a per-source bucket context (two bulk
      // queries, loaded lazily below) instead of the SQL bucket functions — those cost ~2 full
      // `offers` scans + per-bucket-row snapshot lookups PER CANDIDATE, measured at 7.5M rows
      // read per 16-source scan against Turso; the context brings a scan to ~hundreds of K.
      // Equivalence: the process phase is sequential per source and writes nothing during this
      // loop, so the context (loaded after this source's ingest) is exactly the state the SQL
      // functions would read — asserted by market.test.ts's parity test. The dashboard computes
      // its own discount at read time (api.ts), so this has ZERO effect on what the board shows.
      let discount: DiscountResult = NO_DISCOUNT;
      if (matches.length > 0) {
        bucketCtx ??= await loadBucketContext(db);
        const ownSnapshots = await ownSnapshotsFor(db, ingest.offerId, now);
        const buckets = bucketPricesInMemory(ingest.offerId, keyOffer, bucketCtx.actives, bucketCtx.latestPriceByOfferId);
        discount = computeRealDiscount({
          current: offer.pricePerPerson,
          ownSnapshots,
          omnibus: offer.omnibusLowestPrice,
          nights: offer.nights,
          hotelTermPricesPN: buckets.hotelTermPricesPN,
          localityPricesPN: buckets.localityPricesPN,
          marketPricesPN: buckets.marketPricesPN,
          claimedPct: offer.claimedDiscountPct,
          now,
        });
      }

      const outcomes = evaluateOffer({
        offerId: ingest.offerId,
        offer,
        newOfferEligible: !isRekeyFlood && isNewOfferEligible(ingest, now),
        previousPrice: ingest.previousPrice,
        discount,
        matches,
        cfg: cfg.notifications,
      });

      // ingestSourceOffers already persisted the match_key (from the sticky-guarded title);
      // recompute here from keyOffer (pure, no DB round-trip) — NOT the raw incoming `offer` — so the
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
/** notifications_log `type` for scraper-health alerts (not an offer notification). */
const HEALTH_ALERT_TYPE = 'health_alert';
/** Synthetic per-source dedup identity stored in notifications_log.match_key. */
const HEALTH_ALERT_IDENTITY_PREFIX = 'health:';
/** At most one health alert per source per 24h. */
const HEALTH_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Chronic trigger needs a meaningful window before it can fire. */
const HEALTH_CHRONIC_MIN_RUNS = 6;
/** Share of recent runs that must be barren for the chronic trigger. */
const HEALTH_CHRONIC_BAD_RATE = 0.5;

async function maybeSendHealthAlert(
  db: Db,
  source: string,
  telegram: Telegram | null,
  dryRun: boolean,
  now: Date,
): Promise<boolean> {
  // Pull a generous window and drop the benign backoff-skip bookkeeping rows: a persistently
  // blocked source alternates failed / backoff-partial rows, so counting raw rows would break the
  // consecutive-failure chain and the alert would NEVER fire (I2 defect). The chain is computed
  // over REAL runs only; index 0 of the filtered sequence = current run just written.
  const rows = await db
    .select({ status: sourceRuns.status, errorSample: sourceRuns.errorSample, offersFound: sourceRuns.offersFound })
    .from(sourceRuns)
    .where(eq(sourceRuns.source, source))
    .orderBy(desc(sourceRuns.id))
    .limit(RECENT_RUN_SCAN_LIMIT);
  const recent = rows.filter((r) => !isBackoffRow(r.errorSample));
  if (recent.length === 0) return false;

  // "Barren" = the run produced nothing usable: an outright failure, OR a run that finished but
  // returned zero offers. The old rule looked only at status==='failed', so zajezdy — the largest
  // source — logged status 'partial' with 0 offers on 68% of its runs and never once alerted
  // (audit 2026-07-29).
  const barrenAt = (i: number): boolean => {
    const r = recent[i];
    if (!r) return false; // absent = no evidence of trouble
    return r.status === 'failed' || (r.offersFound ?? 0) === 0;
  };

  // Two independent triggers:
  // (a) ACUTE — three barren runs in a row (the classic "scraper just broke").
  // (b) CHRONIC — at least half of a full window is barren. The old 2→3-transition-only rule was
  //     blind to sources that alternate fail/succeed forever: etravel failed 38% of runs and
  //     alerted once ever; eximtours 31% and fischer 27% never alerted at all.
  const acute = barrenAt(0) && barrenAt(1) && barrenAt(2);
  const barrenCount = recent.filter((_, i) => barrenAt(i)).length;
  const chronic =
    recent.length >= HEALTH_CHRONIC_MIN_RUNS && barrenCount / recent.length >= HEALTH_CHRONIC_BAD_RATE;
  if (!acute && !chronic) return false;

  // Rate limit + audit trail in one: the alert is recorded in notifications_log under a synthetic
  // per-source identity, so (1) repeated alerts inside the cooldown are suppressed — the old rule
  // re-fired every time a flapping source's streak re-reached 3 (16 alerts in 7 days from
  // dovolenkovani+firo alone) — and (2) health alerts finally show up in notification audits,
  // where they were previously invisible.
  const identity = `${HEALTH_ALERT_IDENTITY_PREFIX}${source}`;
  const [last] = await db
    .select({ sentAt: notificationsLog.sentAt })
    .from(notificationsLog)
    .where(and(eq(notificationsLog.matchKey, identity), eq(notificationsLog.type, HEALTH_ALERT_TYPE)))
    .orderBy(desc(notificationsLog.id))
    .limit(1);
  if (last && now.getTime() - new Date(last.sentAt).getTime() < HEALTH_ALERT_COOLDOWN_MS) return false;

  const reason = acute
    ? 'selhal 3× v řadě'
    : `nic nevrátil v ${barrenCount} z posledních ${recent.length} běhů`;
  if (!dryRun && telegram) {
    await telegram.send(`🛠 Zdroj <b>${source}</b> ${reason} — scraper může být rozbitý.`);
  }
  if (!dryRun) {
    await db.insert(notificationsLog).values({
      offerId: null,
      type: HEALTH_ALERT_TYPE,
      sentAt: now.toISOString(),
      priceAtSend: null,
      matchKey: identity,
    });
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

  // --- Per-source scan: two phases (Task 47) ---
  // Phase 1 FETCH (concurrent by default): compute one FetchOutcome per adapter. The slow part of a
  // scan is network wait inside adapter.fetchOffers (per-host politeness gaps), so overlapping the
  // fetches cuts wall-time from ~12min (summed) to ~90s (slowest single adapter) and fits a
  // serverless 300s window. This does NOT hammer any host: the shared HttpClient (deps.http)
  // serializes requests PER HOST via its promise-queue, so different adapters (different hosts)
  // overlap while two adapters sharing a host stay serialized by that queue. No throttling is added.
  //
  // Phase 2 PROCESS (always sequential, in `adapters` order): replay the exact original per-source
  // body over the outcomes. Keeping this sequential preserves allCandidates completeness/order,
  // cross-source dedup, the message cap, digest gating, and avoids concurrent DB write contention.
  const concurrency = deps.concurrency ?? 'concurrent';

  type FetchOutcome =
    | { adapter: SourceAdapter; kind: 'backoff'; backoffUntil: string }
    | { adapter: SourceAdapter; kind: 'fetched'; fetched: NormalizedOffer[] }
    | { adapter: SourceAdapter; kind: 'error'; err: unknown };

  // Everything up to and including the network fetch for one source. The 24h backoff check (spec §9)
  // stays OUTSIDE the try — as in the original loop, a failure reading run history is not an
  // adapter error and propagates. loadPriorTitles + fetchOffers stay INSIDE it, so a fetch failure
  // is captured as kind:'error' and replayed through the original catch in phase 2.
  async function fetchOne(adapter: SourceAdapter): Promise<FetchOutcome> {
    const backoffUntil = await blockedBackoffUntil(db, adapter.name, now);
    if (backoffUntil) return { adapter, kind: 'backoff', backoffUntil };
    try {
      const priorTitles = await loadPriorTitles(db, adapter.name);
      const fetched = await withTimeout(
        adapter.fetchOffers({ http: deps.http, adults: cfg.scan.adults, log, priorTitles }),
        deps.adapterTimeoutMs ?? ADAPTER_FETCH_TIMEOUT_MS,
        adapter.name,
      );
      return { adapter, kind: 'fetched', fetched };
    } catch (err) {
      return { adapter, kind: 'error', err };
    }
  }

  let outcomes: FetchOutcome[];
  if (concurrency === 'concurrent') {
    // Promise.all preserves input order in its result array → outcomes order === adapters order.
    outcomes = await Promise.all(adapters.map(fetchOne));
  } else {
    outcomes = [];
    for (const adapter of adapters) outcomes.push(await fetchOne(adapter));
  }

  for (const outcome of outcomes) {
    const adapter = outcome.adapter;
    const startedAt = now.toISOString();

    // 24h backoff after a block (spec §9): the source was skipped entirely (no adapter call);
    // record a benign 'partial'/backoff run so history stays continuous and this doesn't count
    // toward the 3×-failed health alert.
    if (outcome.kind === 'backoff') {
      log(`source ${adapter.name}: backoff po blokaci, přeskakuji do ${outcome.backoffUntil}`);
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

    let status: 'ok' | 'partial' | 'failed';
    let offersFound = 0;
    let snapshotsWritten = 0;
    let errorCount = 0;
    let errorSample: string | null = null;
    let errorMessage: string | undefined;

    try {
      // A fetch-phase failure is re-thrown here so it funnels through the SAME catch the original
      // single-phase loop used — identical 'failed' handling (incl. SourceBlockedError → BLOCKED
      // prefix) for both fetch errors and any error raised while processing below.
      if (outcome.kind === 'error') throw outcome.err;

      const fetched = outcome.fetched;
      offersFound = fetched.length;

      const processed = await processOffers(db, cfg, fetched, now, log, excluded, dryRun);
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
  // Collapse several types of the same offer into one message AFTER the log filter, so a
  // suppressed hot_deal cannot keep beating (and permanently starving) that offer's new_offer.
  const oneEach = collapseTypes(eligible);
  const { send, overflow } = capMessages(oneEach, cfg.notifications.maxMessagesPerRun);

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
      await maybeSendHealthAlert(db, s.source, telegram, dryRun, now);
    }
  }

  return { perSource, notificationsSent, digestSent };
}
