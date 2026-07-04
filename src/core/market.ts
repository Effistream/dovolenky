import { and, desc, eq, gte, isNull, ne, sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { offers, priceSnapshots } from './db/schema.js';
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
export async function ownSnapshotsFor(db: Db, offerId: number, now: Date): Promise<{ price: number; at: string }[]> {
  const windowStartIso = new Date(now.getTime() - OWN_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = await db
    .select({ price: priceSnapshots.pricePerPerson, at: priceSnapshots.capturedAt })
    .from(priceSnapshots)
    .where(and(eq(priceSnapshots.offerId, offerId), gte(priceSnapshots.capturedAt, windowStartIso)));
  return rows.map((r) => ({ price: r.price, at: r.at }));
}
