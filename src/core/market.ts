import { and, desc, eq, gte, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { offers, priceSnapshots } from './db/schema.js';
import { computeHotelKey, computeMatchKey } from './normalize.js';
import type { NormalizedOffer } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const OWN_WINDOW_DAYS = 30;
const HOTEL_NIGHTS_TOLERANCE = 2;
const HOTEL_DATE_WINDOW_DAYS = 30;

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
 * Pure per-NIGHT normalization + cross-source twin dedup (spec §13/§15) over rows
 * that already carry their latest price. Each row's `price` is divided by its own
 * `nights` and rounded; rows with null/<1 nights are skipped (cannot normalize).
 * Rows sharing a match_key collapse to a single MIN(per-night) contribution — the
 * cheapest *comparable* term wins — while NULL-match_key rows stay individual.
 * The DB path (perNightPricesFor) and the in-memory read path (bucketPricesInMemory)
 * both funnel through this so the dedup math has ONE definition. Result order is
 * irrelevant — computeRealDiscount only takes its median/length.
 */
function perNightReduce(rows: { matchKey: string | null; nights: number | null; price: number }[]): number[] {
  const groupMin = new Map<string, number>();
  const prices: number[] = [];
  for (const row of rows) {
    if (row.nights == null || row.nights < 1) continue; // cannot normalize per-night
    const perNight = Math.round(row.price / row.nights);
    if (row.matchKey == null) {
      prices.push(perNight);
    } else {
      const prev = groupMin.get(row.matchKey);
      if (prev == null || perNight < prev) groupMin.set(row.matchKey, perNight);
    }
  }
  return [...prices, ...groupMin.values()];
}

/**
 * DB path (run.ts/digest.ts, mid-scan): fetch each candidate bucket row's latest
 * snapshot price, then perNightReduce. Post-processed in JS (not a GROUP BY)
 * because "latest snapshot per offer" needs a per-row subquery. The web read path
 * does NOT use this — it preloads prices and calls bucketPricesInMemory instead.
 */
async function perNightPricesFor(
  db: Db,
  rows: { id: number; matchKey: string | null; nights: number | null }[],
): Promise<number[]> {
  const withPrice: { matchKey: string | null; nights: number | null; price: number }[] = [];
  for (const row of rows) {
    if (row.nights == null || row.nights < 1) continue; // cannot normalize per-night
    const [snap] = await db
      .select({ price: priceSnapshots.pricePerPerson })
      .from(priceSnapshots)
      .where(eq(priceSnapshots.offerId, row.id))
      .orderBy(desc(priceSnapshots.id))
      .limit(1);
    if (!snap) continue;
    withPrice.push({ matchKey: row.matchKey, nights: row.nights, price: snap.price });
  }
  return perNightReduce(withPrice);
}

/**
 * Market bucket baseline (spec §6/§15): per-NIGHT latest snapshot price per
 * *active* offer in the same bucket — country × departure month × nights band ×
 * board × stars — excluding the offer itself (and its cross-source twin).
 * computeRealDiscount enforces the ≥8 rule, so we return every per-night price
 * found and let it decide. This is the last-resort tier of the discount ladder.
 */
export async function marketBucketPrices(db: Db, offerId: number, offer: NormalizedOffer): Promise<number[]> {
  const month = departureMonth(offer.departureDate);
  const band = nightsBand(offer.nights);
  // Cross-source dedup fix: computeMatchKey is pure, so we recompute the
  // subject's own key here (rather than trusting a caller-supplied value) to
  // exclude its cross-listed twin from the bucket too — otherwise the twin's
  // (≈ the subject's own) price survives group-MIN and biases the baseline
  // toward "no discount". A NULL subject key opts out of this (matches
  // computeMatchKey's own null semantics), leaving prior behavior unchanged.
  const subjectKey = computeMatchKey(offer);

  const conditions = [
    ne(offers.id, offerId),
    eq(offers.active, true),
    offer.country == null ? isNull(offers.country) : eq(offers.country, offer.country),
    offer.board == null ? isNull(offers.board) : eq(offers.board, offer.board),
    offer.stars == null ? isNull(offers.stars) : eq(offers.stars, offer.stars),
  ];
  // (or() with two concrete args never actually returns undefined; the `!` just
  // satisfies drizzle's overly-permissive SQL<unknown> | undefined return type.)
  if (subjectKey != null) conditions.push(or(isNull(offers.matchKey), ne(offers.matchKey, subjectKey))!);

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
    .select({ id: offers.id, matchKey: offers.matchKey, nights: offers.nights })
    .from(offers)
    .where(and(...conditions));

  return perNightPricesFor(db, rows);
}

/**
 * Hotel-term per-night baseline (spec §15, "hotel" rung): per-NIGHT latest
 * snapshot prices of OTHER active terms of the *same physical hotel* — same
 * hotel_key (computed from the subject via computeHotelKey; null → []), same
 * board, |nights − offer.nights| ≤ 2, departureDate within ±30 days of the
 * subject — excluding the subject itself and its cross-source twins (match_key).
 * computeRealDiscount enforces the ≥4 rule. Answers "is this term cheap *for this
 * hotel*?".
 */
export async function hotelTermPricesPN(db: Db, offerId: number, offer: NormalizedOffer): Promise<number[]> {
  const hotelKey = computeHotelKey(offer);
  if (hotelKey == null) return []; // under-specified hotel identity → no pool

  const subjectKey = computeMatchKey(offer);

  const conditions = [
    ne(offers.id, offerId),
    eq(offers.active, true),
    eq(offers.hotelKey, hotelKey),
    offer.board == null ? isNull(offers.board) : eq(offers.board, offer.board),
  ];
  if (subjectKey != null) conditions.push(or(isNull(offers.matchKey), ne(offers.matchKey, subjectKey))!);

  // Nights within ±2 of the subject. A null subject nights can't define a band,
  // so no hotel comparison is possible (per-night needs a nights count anyway).
  if (offer.nights == null) return [];
  conditions.push(gte(offers.nights, offer.nights - HOTEL_NIGHTS_TOLERANCE));
  conditions.push(lte(offers.nights, offer.nights + HOTEL_NIGHTS_TOLERANCE));

  // Departure date within ±30 days (inclusive) of the subject's departure. A null
  // subject departure has no window to compare against.
  if (offer.departureDate == null) return [];
  const dep = new Date(`${offer.departureDate}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(dep)) return [];
  const loIso = new Date(dep - HOTEL_DATE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const hiIso = new Date(dep + HOTEL_DATE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  conditions.push(gte(offers.departureDate, loIso));
  conditions.push(lte(offers.departureDate, hiIso));

  const rows = await db
    .select({ id: offers.id, matchKey: offers.matchKey, nights: offers.nights })
    .from(offers)
    .where(and(...conditions));

  return perNightPricesFor(db, rows);
}

/**
 * Locality per-night baseline (spec §15, "locality" rung): per-NIGHT latest
 * snapshot prices of active offers in the bucket locality × departure month ×
 * board × stars (subject's locality non-null; null → []) — excluding the subject
 * and its cross-source twins. computeRealDiscount enforces the ≥8 rule. Answers
 * "is this cheap for <locality> this month?".
 */
export async function localityBucketPricesPN(db: Db, offerId: number, offer: NormalizedOffer): Promise<number[]> {
  if (offer.locality == null) return []; // no locality → this rung doesn't apply
  const month = departureMonth(offer.departureDate);
  const subjectKey = computeMatchKey(offer);

  const conditions = [
    ne(offers.id, offerId),
    eq(offers.active, true),
    eq(offers.locality, offer.locality),
    offer.board == null ? isNull(offers.board) : eq(offers.board, offer.board),
    offer.stars == null ? isNull(offers.stars) : eq(offers.stars, offer.stars),
  ];
  if (subjectKey != null) conditions.push(or(isNull(offers.matchKey), ne(offers.matchKey, subjectKey))!);

  // Departure month (compare the YYYY-MM prefix).
  if (month == null) {
    conditions.push(isNull(offers.departureDate));
  } else {
    conditions.push(sql`substr(${offers.departureDate}, 1, 7) = ${month}`);
  }

  const rows = await db
    .select({ id: offers.id, matchKey: offers.matchKey, nights: offers.nights })
    .from(offers)
    .where(and(...conditions));

  return perNightPricesFor(db, rows);
}

/** Own-history snapshots for an offer over the last 30 days, as {price, at}. */
export async function ownSnapshotsFor(db: Db, offerId: number, now: Date): Promise<{ price: number; at: string }[]> {
  const windowStartIso = new Date(now.getTime() - OWN_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = await db
    .select({ price: priceSnapshots.pricePerPerson, at: priceSnapshots.capturedAt })
    .from(priceSnapshots)
    .where(and(eq(priceSnapshots.offerId, offerId), gte(priceSnapshots.capturedAt, windowStartIso)));
  return rows.map((r) => ({ price: r.price, at: r.at }));
}

/**
 * The offer-row fields the in-memory bucket filter needs (a lightweight view of
 * an active `offers` row).
 */
export interface ActiveOfferLite {
  id: number;
  country: string | null;
  locality: string | null;
  board: string | null;
  stars: number | null;
  nights: number | null;
  departureDate: string | null;
  matchKey: string | null;
  hotelKey: string | null;
}

/** Everything bucketPricesInMemory needs, loaded in two bulk queries. */
export interface BucketContext {
  actives: ActiveOfferLite[];
  latestPriceByOfferId: Map<number, number>;
}

/**
 * Loads the full in-memory bucket context — every ACTIVE offer (lite view) plus
 * each one's latest snapshot price (max-id per offer) — in exactly TWO queries.
 * The scan's per-candidate reference ladder uses this with bucketPricesInMemory
 * instead of the SQL bucket functions above: those cost ~2 full `offers` scans +
 * per-bucket-row snapshot lookups PER CANDIDATE (measured 7.5M rows read per
 * 16-source scan — the dominant Turso rows-read driver), while this context is
 * ~one offers read + one covering-index walk per SOURCE. Load it AFTER a source's
 * ingest; the process phase is sequential per source and writes nothing during
 * candidate evaluation, so the snapshot is exactly the state the SQL functions
 * would read.
 */
export async function loadBucketContext(db: Db): Promise<BucketContext> {
  const actives: ActiveOfferLite[] = await db
    .select({
      id: offers.id,
      country: offers.country,
      locality: offers.locality,
      board: offers.board,
      stars: offers.stars,
      nights: offers.nights,
      departureDate: offers.departureDate,
      matchKey: offers.matchKey,
      hotelKey: offers.hotelKey,
    })
    .from(offers)
    .where(eq(offers.active, true));

  const latestIds = db
    .select({ offerId: priceSnapshots.offerId, maxId: sql<number>`max(${priceSnapshots.id})`.as('max_id') })
    .from(priceSnapshots)
    .groupBy(priceSnapshots.offerId)
    .as('latest_ids');
  const rows = await db
    .select({ offerId: priceSnapshots.offerId, price: priceSnapshots.pricePerPerson })
    .from(priceSnapshots)
    .innerJoin(latestIds, eq(priceSnapshots.id, latestIds.maxId));

  const latestPriceByOfferId = new Map<number, number>();
  for (const r of rows) latestPriceByOfferId.set(r.offerId, r.price);
  return { actives, latestPriceByOfferId };
}

// SQL `col == null ? isNull(col) : eq(col, val)` in JS: candidate equals the
// subject's value, treating null as a matchable value.
function eqNullable<T>(candidate: T | null, subject: T | null): boolean {
  return subject == null ? candidate == null : candidate === subject;
}

// SQL month predicate: `month == null ? isNull(departureDate) : substr(dd,1,7) == month`.
function matchesMonth(candidateDeparture: string | null, month: string | null): boolean {
  if (month == null) return candidateDeparture == null;
  return candidateDeparture != null && candidateDeparture.slice(0, 7) === month;
}

// SQL nights-band predicate: null band → isNull(nights); else nights in [lo, hi]
// (null candidate nights excluded, matching SQL's null-comparison → false).
function matchesNightsBand(candidateNights: number | null, band: { lo: number | null; hi: number | null }): boolean {
  if (band.lo == null) return candidateNights == null;
  if (candidateNights == null) return false;
  if (candidateNights < band.lo) return false;
  if (band.hi != null && candidateNights > band.hi) return false;
  return true;
}

/**
 * In-memory equivalent of {market,locality,hotel}BucketPrices for the web read
 * path: given the subject offer, ALL active offers (a lightweight view) and a
 * preloaded latest-price map, it computes all three per-night reference buckets
 * in a single pass — zero DB round-trips. The SQL functions above stay the source
 * of truth for run.ts/digest.ts; market.test.ts asserts this returns identical
 * results for every offer (same predicates, same perNightReduce). Ordering is
 * irrelevant (computeRealDiscount only medians/counts each bucket).
 */
export function bucketPricesInMemory(
  offerId: number,
  offer: NormalizedOffer,
  actives: readonly ActiveOfferLite[],
  latestPriceByOfferId: ReadonlyMap<number, number>,
): { hotelTermPricesPN: number[]; localityPricesPN: number[]; marketPricesPN: number[] } {
  const subjectKey = computeMatchKey(offer);
  const hotelKey = computeHotelKey(offer);
  const month = departureMonth(offer.departureDate);
  const band = nightsBand(offer.nights);

  // Hotel rung ±30-day departure window (only when the subject's departure is a
  // valid date — mirrors hotelTermPricesPN's early `return []`).
  let hotelDepLo: string | null = null;
  let hotelDepHi: string | null = null;
  if (offer.departureDate != null) {
    const dep = new Date(`${offer.departureDate}T00:00:00.000Z`).getTime();
    if (Number.isFinite(dep)) {
      hotelDepLo = new Date(dep - HOTEL_DATE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
      hotelDepHi = new Date(dep + HOTEL_DATE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
    }
  }
  // Whole-rung guards mirroring each SQL fn's early `return []`.
  const hotelPossible = hotelKey != null && offer.nights != null && hotelDepLo != null && hotelDepHi != null;
  const localityPossible = offer.locality != null;

  const hotelRows: { matchKey: string | null; nights: number | null; price: number }[] = [];
  const localityRows: { matchKey: string | null; nights: number | null; price: number }[] = [];
  const marketRows: { matchKey: string | null; nights: number | null; price: number }[] = [];

  for (const c of actives) {
    if (c.id === offerId) continue; // ne(id, offerId)
    const price = latestPriceByOfferId.get(c.id);
    if (price == null) continue; // no snapshot → no contribution (SQL: `if (!snap) continue`)
    // Cross-source twin exclusion: keep rows with null match_key or a differing
    // key; drop the subject's own twin. subjectKey null → no exclusion (all kept).
    if (subjectKey != null && c.matchKey != null && c.matchKey === subjectKey) continue;

    const row = { matchKey: c.matchKey, nights: c.nights, price };

    // MARKET: country × board × stars × nights band × departure month.
    if (
      eqNullable(c.country, offer.country) &&
      eqNullable(c.board, offer.board) &&
      eqNullable(c.stars, offer.stars) &&
      matchesNightsBand(c.nights, band) &&
      matchesMonth(c.departureDate, month)
    ) {
      marketRows.push(row);
    }

    // LOCALITY: same locality × board × stars × departure month (no nights band).
    if (
      localityPossible &&
      c.locality === offer.locality &&
      eqNullable(c.board, offer.board) &&
      eqNullable(c.stars, offer.stars) &&
      matchesMonth(c.departureDate, month)
    ) {
      localityRows.push(row);
    }

    // HOTEL: same hotel_key × board × nights ±2 × departure ±30 days.
    if (
      hotelPossible &&
      c.hotelKey === hotelKey &&
      eqNullable(c.board, offer.board) &&
      c.nights != null &&
      c.nights >= offer.nights! - HOTEL_NIGHTS_TOLERANCE &&
      c.nights <= offer.nights! + HOTEL_NIGHTS_TOLERANCE &&
      c.departureDate != null &&
      c.departureDate >= hotelDepLo! &&
      c.departureDate <= hotelDepHi!
    ) {
      hotelRows.push(row);
    }
  }

  return {
    hotelTermPricesPN: hotelPossible ? perNightReduce(hotelRows) : [],
    localityPricesPN: localityPossible ? perNightReduce(localityRows) : [],
    marketPricesPN: perNightReduce(marketRows),
  };
}
