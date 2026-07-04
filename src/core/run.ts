import { and, desc, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { offers, priceSnapshots, notificationsLog, sourceRuns } from './db/schema.js';
import type { AppConfig } from './config.js';
import type { Telegram } from './telegram.js';
import type { NormalizedOffer, SourceAdapter } from './types.js';
import { ingestOffer, markMissedOffers } from './ingest.js';
import { computeRealDiscount, type DiscountResult } from './discount.js';
import { matchProfiles } from './filters.js';
import { evaluateOffer, filterAgainstLog, recordSent, capMessages, type Candidate } from './notify.js';
import { formatOffer, formatDigest } from './format.js';
import { pragueDayString } from './dates.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const OWN_WINDOW_DAYS = 30;
const DIGEST_TOP_N = 10;

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

/** Maps a nights value to a band index: ≤5, 6–8, 9–12, 13+. null → its own band. */
function nightsBand(nights: number | null): { lo: number | null; hi: number | null } {
  if (nights == null) return { lo: null, hi: null };
  if (nights <= 5) return { lo: 0, hi: 5 };
  if (nights <= 8) return { lo: 6, hi: 8 };
  if (nights <= 12) return { lo: 9, hi: 12 };
  return { lo: 13, hi: null };
}

/** ISO month string (YYYY-MM) of a departure date, or null. */
function departureMonth(departureDate: string | null): string | null {
  if (!departureDate) return null;
  const m = /^(\d{4}-\d{2})/.exec(departureDate);
  return m ? m[1]! : null;
}

/**
 * Market bucket baseline (spec §6): latest snapshot price per *active* offer in
 * the same bucket — country × departure month × nights band × board × stars —
 * excluding the offer itself. computeRealDiscount enforces the ≥8 rule, so we
 * return every price found and let it decide.
 */
async function marketBucketPrices(db: Db, offerId: number, offer: NormalizedOffer): Promise<number[]> {
  const month = departureMonth(offer.departureDate);
  const band = nightsBand(offer.nights);

  const conditions = [
    ne(offers.id, offerId),
    eq(offers.active, true),
    offer.country == null ? isNull(offers.country) : eq(offers.country, offer.country),
    offer.board == null ? isNull(offers.board) : eq(offers.board, offer.board),
    offer.stars == null ? isNull(offers.stars) : eq(offers.stars, offer.stars),
  ];

  // Nights band range.
  if (band.lo == null) {
    conditions.push(isNull(offers.nights));
  } else {
    conditions.push(gte(offers.nights, band.lo));
    if (band.hi != null) conditions.push(sql`${offers.nights} <= ${band.hi}`);
  }

  // Departure month (compare the YYYY-MM prefix).
  if (month == null) {
    conditions.push(isNull(offers.departureDate));
  } else {
    conditions.push(sql`substr(${offers.departureDate}, 1, 7) = ${month}`);
  }

  const rows = await db
    .select({ id: offers.id })
    .from(offers)
    .where(and(...conditions));

  const prices: number[] = [];
  for (const row of rows) {
    const [snap] = await db
      .select({ price: priceSnapshots.pricePerPerson })
      .from(priceSnapshots)
      .where(eq(priceSnapshots.offerId, row.id))
      .orderBy(desc(priceSnapshots.id))
      .limit(1);
    if (snap) prices.push(snap.price);
  }
  return prices;
}

/** Own-history snapshots for an offer over the last 30 days, as {price, at}. */
async function ownSnapshotsFor(db: Db, offerId: number, now: Date): Promise<{ price: number; at: string }[]> {
  const windowStartIso = new Date(now.getTime() - OWN_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = await db
    .select({ price: priceSnapshots.pricePerPerson, at: priceSnapshots.capturedAt })
    .from(priceSnapshots)
    .where(and(eq(priceSnapshots.offerId, offerId), gte(priceSnapshots.capturedAt, windowStartIso)));
  return rows.map((r) => ({ price: r.price, at: r.at }));
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
 * Digest (spec §7). Kept as a clearly-marked standalone function so Task 19 can
 * lift it into core/digest.ts. Sends the daily digest iff the current Prague
 * hour ≥ digestHour AND no digest was logged for today's Prague day yet.
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

  // Build digest: top 10 active offers by realPct across all profiles.
  const activeRows = await db.select().from(offers).where(eq(offers.active, true));

  const items: { offer: NormalizedOffer; d: DiscountResult }[] = [];
  for (const row of activeRows) {
    const [snap] = await db
      .select()
      .from(priceSnapshots)
      .where(eq(priceSnapshots.offerId, row.id))
      .orderBy(desc(priceSnapshots.id))
      .limit(1);
    if (!snap) continue;

    const offer: NormalizedOffer = {
      source: row.source,
      sourceOfferKey: row.sourceOfferKey,
      title: row.title,
      country: row.country,
      locality: row.locality,
      stars: row.stars,
      board: (row.board ?? 'unknown') as NormalizedOffer['board'],
      transport: (row.transport ?? 'unknown') as NormalizedOffer['transport'],
      departureAirport: row.departureAirport,
      departureDate: row.departureDate,
      nights: row.nights,
      pricePerPerson: snap.pricePerPerson,
      priceTotal: snap.priceTotal,
      claimedOriginalPrice: snap.claimedOriginalPrice,
      claimedDiscountPct: snap.claimedDiscountPct,
      omnibusLowestPrice: snap.omnibusLowestPrice,
      tourOperator: row.tourOperator,
      url: row.url,
    };

    const ownSnapshots = await ownSnapshotsFor(db, row.id, now);
    const marketPrices = await marketBucketPrices(db, row.id, offer);
    const d = computeRealDiscount({
      current: snap.pricePerPerson,
      ownSnapshots,
      omnibus: snap.omnibusLowestPrice,
      marketPrices,
      claimedPct: snap.claimedDiscountPct,
      now,
    });
    items.push({ offer, d });
  }

  // Sort by realPct desc; nulls last.
  items.sort((a, b) => {
    const ap = a.d.realPct;
    const bp = b.d.realPct;
    if (ap == null && bp == null) return 0;
    if (ap == null) return 1;
    if (bp == null) return -1;
    return bp - ap;
  });

  const top = items.slice(0, DIGEST_TOP_N);

  // Market stats.
  const activeOffers = activeRows.length;
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const newRows = await db
    .select({ id: offers.id })
    .from(offers)
    .where(gte(offers.firstSeenAt, cutoff));
  const newLast24h = newRows.length;

  const html = formatDigest(top, { activeOffers, newLast24h });

  // A null telegram is treated like a dry run for sends: report that a digest
  // *would* be sent, but neither transmit nor log it (only real sends persist).
  if (!dryRun && telegram) {
    await telegram.send(html);
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
