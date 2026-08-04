import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { offers, priceSnapshots } from './db/schema.js';

/**
 * Bulk snapshot loaders shared by every read path that ranks the whole active set — the board
 * (web/api.ts) and the daily digest (core/digest.ts).
 *
 * Both used to walk their representatives one at a time, which is fine at a few hundred offers and
 * ruinous at scale: after the 2026-07-29 coverage work the digest issued two queries per
 * representative over ~7 400 of them (~14 800 round-trips) and pushed a scan from 8 to 22 minutes,
 * heading straight for the GitHub job's 30-minute ceiling. These two queries replace all of it.
 */

/** The subset of a price snapshot a ranking read path needs (latest per offer). */
export interface LatestSnap {
  pricePerPerson: number;
  priceTotal: number | null;
  claimedOriginalPrice: number | null;
  claimedDiscountPct: number | null;
  omnibusLowestPrice: number | null;
}

/**
 * Latest snapshot for every ACTIVE offer, in a single query (max(id) per offer_id, joined back to
 * its row, restricted to active offers). No writes happen during a read, so the map is consistent
 * for the whole request.
 */
export async function loadLatestSnapshots(db: Db): Promise<Map<number, LatestSnap>> {
  const latestIds = db
    .select({ offerId: priceSnapshots.offerId, maxId: sql<number>`max(${priceSnapshots.id})`.as('max_id') })
    .from(priceSnapshots)
    .groupBy(priceSnapshots.offerId)
    .as('latest_ids');

  const rows = await db
    .select({
      offerId: priceSnapshots.offerId,
      pricePerPerson: priceSnapshots.pricePerPerson,
      priceTotal: priceSnapshots.priceTotal,
      claimedOriginalPrice: priceSnapshots.claimedOriginalPrice,
      claimedDiscountPct: priceSnapshots.claimedDiscountPct,
      omnibusLowestPrice: priceSnapshots.omnibusLowestPrice,
    })
    .from(priceSnapshots)
    .innerJoin(latestIds, eq(priceSnapshots.id, latestIds.maxId))
    .innerJoin(offers, and(eq(offers.id, priceSnapshots.offerId), eq(offers.active, true)));

  const map = new Map<number, LatestSnap>();
  for (const r of rows) {
    map.set(r.offerId, {
      pricePerPerson: r.pricePerPerson,
      priceTotal: r.priceTotal,
      claimedOriginalPrice: r.claimedOriginalPrice,
      claimedDiscountPct: r.claimedDiscountPct,
      omnibusLowestPrice: r.omnibusLowestPrice,
    });
  }
  return map;
}

/**
 * All price snapshots from the last `windowDays` days, grouped by offer id and ordered
 * oldest→newest within each offer. Serves BOTH the own-history baseline (computeRealDiscount
 * medians the full window) and the board's sparkline. Active offers are seen recently, so their
 * latest writes fall inside this window.
 */
export async function loadRecentSnapshots(
  db: Db,
  now: Date,
  windowDays: number,
): Promise<Map<number, { price: number; at: string }[]>> {
  const sinceIso = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db
    .select({ offerId: priceSnapshots.offerId, price: priceSnapshots.pricePerPerson, at: priceSnapshots.capturedAt })
    .from(priceSnapshots)
    .where(gte(priceSnapshots.capturedAt, sinceIso))
    .orderBy(priceSnapshots.offerId, priceSnapshots.id);

  const map = new Map<number, { price: number; at: string }[]>();
  for (const r of rows) {
    let list = map.get(r.offerId);
    if (!list) {
      list = [];
      map.set(r.offerId, list);
    }
    list.push({ price: r.price, at: r.at });
  }
  return map;
}
