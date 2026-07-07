import { and, desc, eq, gte, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { offers, priceSnapshots } from './db/schema.js';
import { computeMatchKey } from './normalize.js';
import type { NormalizedOffer } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const OWN_WINDOW_DAYS = 30;

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
    .select({ id: offers.id, matchKey: offers.matchKey })
    .from(offers)
    .where(and(...conditions));

  // Cross-source dedup (spec §13): the same physical tour aggregated by several
  // sources would otherwise over-weight the market median. Collapse rows sharing
  // a match_key to a single MIN(price) contribution; rows with a NULL match_key
  // are left individual (no cross-source pairing). Post-process in JS rather than
  // a GROUP BY: the "latest snapshot per offer" price already needs a per-row
  // subquery loop, and grouping the resulting numbers here keeps that in one place.
  const groupMin = new Map<string, number>();
  const prices: number[] = [];
  for (const row of rows) {
    const [snap] = await db
      .select({ price: priceSnapshots.pricePerPerson })
      .from(priceSnapshots)
      .where(eq(priceSnapshots.offerId, row.id))
      .orderBy(desc(priceSnapshots.id))
      .limit(1);
    if (!snap) continue;

    if (row.matchKey == null) {
      prices.push(snap.price);
    } else {
      const prev = groupMin.get(row.matchKey);
      if (prev == null || snap.price < prev) groupMin.set(row.matchKey, snap.price);
    }
  }
  return [...prices, ...groupMin.values()];
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
