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
 * Given a set of candidate rows (each already filtered into a bucket and carrying
 * its match_key + nights), returns the per-NIGHT prices of their latest snapshots,
 * with cross-source twin dedup (spec §13). Shared by all three per-night bucket
 * queries below.
 *
 * Per-night normalization (spec §15): each row's latest `price_per_person` is
 * divided by that row's own `nights` and rounded; rows with null/<1 nights are
 * skipped (cannot normalize). Cross-source dedup then collapses rows sharing a
 * match_key to a single MIN(per-night) contribution — the dedup is done on the
 * per-night value so the cheapest *comparable* term wins — while NULL-match_key
 * rows stay individual. Post-processed in JS (not a GROUP BY) because the
 * "latest snapshot per offer" price already needs a per-row subquery loop.
 */
async function perNightPricesFor(
  db: Db,
  rows: { id: number; matchKey: string | null; nights: number | null }[],
  latestPriceByOfferId?: ReadonlyMap<number, number>,
): Promise<number[]> {
  const groupMin = new Map<string, number>();
  const prices: number[] = [];
  for (const row of rows) {
    if (row.nights == null || row.nights < 1) continue; // cannot normalize per-night

    // Latest per-person price of this bucket row. The read-path (web api) preloads
    // every active offer's latest snapshot once and passes it in as
    // latestPriceByOfferId, collapsing what was a per-bucket-row SELECT — the read
    // path's dominant N+1 — into an in-memory lookup. Callers that don't supply it
    // (run.ts/digest.ts, mid-scan, when the map would be stale) keep the live
    // per-row query. A missing/absent id yields no contribution, exactly as an
    // offer with no snapshot did before.
    let price: number | undefined;
    if (latestPriceByOfferId) {
      price = latestPriceByOfferId.get(row.id);
    } else {
      const [snap] = await db
        .select({ price: priceSnapshots.pricePerPerson })
        .from(priceSnapshots)
        .where(eq(priceSnapshots.offerId, row.id))
        .orderBy(desc(priceSnapshots.id))
        .limit(1);
      price = snap?.price;
    }
    if (price == null) continue;

    const perNight = Math.round(price / row.nights);
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
 * Market bucket baseline (spec §6/§15): per-NIGHT latest snapshot price per
 * *active* offer in the same bucket — country × departure month × nights band ×
 * board × stars — excluding the offer itself (and its cross-source twin).
 * computeRealDiscount enforces the ≥8 rule, so we return every per-night price
 * found and let it decide. This is the last-resort tier of the discount ladder.
 */
export async function marketBucketPrices(db: Db, offerId: number, offer: NormalizedOffer, latestPriceByOfferId?: ReadonlyMap<number, number>): Promise<number[]> {
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

  return perNightPricesFor(db, rows, latestPriceByOfferId);
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
export async function hotelTermPricesPN(db: Db, offerId: number, offer: NormalizedOffer, latestPriceByOfferId?: ReadonlyMap<number, number>): Promise<number[]> {
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

  return perNightPricesFor(db, rows, latestPriceByOfferId);
}

/**
 * Locality per-night baseline (spec §15, "locality" rung): per-NIGHT latest
 * snapshot prices of active offers in the bucket locality × departure month ×
 * board × stars (subject's locality non-null; null → []) — excluding the subject
 * and its cross-source twins. computeRealDiscount enforces the ≥8 rule. Answers
 * "is this cheap for <locality> this month?".
 */
export async function localityBucketPricesPN(db: Db, offerId: number, offer: NormalizedOffer, latestPriceByOfferId?: ReadonlyMap<number, number>): Promise<number[]> {
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

  return perNightPricesFor(db, rows, latestPriceByOfferId);
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
