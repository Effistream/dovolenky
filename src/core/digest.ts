import { desc, eq, gte } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { offers, priceSnapshots } from './db/schema.js';
import type { AppConfig } from './config.js';
import type { NormalizedOffer } from './types.js';
import { computeRealDiscount, type DiscountResult } from './discount.js';
import { formatDigest } from './format.js';
import { bucketPricesInMemory, loadBucketContext, ownSnapshotsFor } from './market.js';
import { hasDeparted } from './dates.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_TOP_N = 10;

/**
 * Assembles the daily digest (spec §7): top 10 active offers by realPct
 * across all profiles, plus a mini-statistic (active offers, new in the last
 * 24h). Pure data assembly + formatting — no sending, no notificationsLog
 * writes; callers (run.ts's gated auto-digest, cli/digest.ts's manual send)
 * own that. Returns null when there are no active offers.
 */
export async function buildDigest(
  db: Db,
  cfg: AppConfig,
  now: Date = new Date(),
  excluded: Set<string> = new Set(),
): Promise<{ html: string; itemCount: number } | null> {
  const activeRowsRaw = await db.select().from(offers).where(eq(offers.active, true));
  // Global negative filter (Task 43): excluded countries are still INGESTED (their
  // price history is preserved by the scan) but MUTED from the digest. Drop them
  // right after fetch so every downstream step — dedup, ranking, and the stats
  // footer (activeOffers) — sees only surfaced offers. NULL-country rows never
  // match an exclusion and always pass through.
  // Digest visibility: excluded countries are muted, and DEPARTED offers (their
  // departure day already passed — some sources keep listing them) can't be
  // bought, so they never belong in a "top deals" digest.
  const activeRows = activeRowsRaw.filter(
    (r) => (r.country == null || !excluded.has(r.country)) && !hasDeparted(r.departureDate, now),
  );
  if (activeRows.length === 0) return null;

  // One bulk bucket context up front: its latest-price map picks the cheapest
  // representative below (replacing a per-row latest-snapshot query), and the
  // items loop reuses it for the in-memory reference ladder.
  const bucketCtx = await loadBucketContext(db);

  // Cross-source dedup (spec §13): collapse active rows sharing a match_key to a
  // single representative — the cheapest by latest price — BEFORE ranking, so a
  // physical tour aggregated across sources appears once in the top-10. Rows with
  // a NULL match_key are never merged (each is its own representative).
  const withPrice: { row: (typeof activeRows)[number]; price: number }[] = [];
  for (const row of activeRows) {
    const price = bucketCtx.latestPriceByOfferId.get(row.id);
    if (price != null) withPrice.push({ row, price });
  }

  const bestByKey = new Map<string, { row: (typeof activeRows)[number]; price: number }>();
  const representatives: (typeof activeRows)[number][] = [];
  for (const entry of withPrice) {
    if (entry.row.matchKey == null) {
      representatives.push(entry.row);
      continue;
    }
    const prev = bestByKey.get(entry.row.matchKey);
    if (prev == null || entry.price < prev.price) bestByKey.set(entry.row.matchKey, entry);
  }
  for (const entry of bestByKey.values()) representatives.push(entry.row);

  const items: { offer: NormalizedOffer; d: DiscountResult }[] = [];
  for (const row of representatives) {
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
    // Per-night reference ladder (spec §15): same assembly as run.ts processOffers.
    const buckets = bucketPricesInMemory(row.id, offer, bucketCtx.actives, bucketCtx.latestPriceByOfferId);
    const d = computeRealDiscount({
      current: snap.pricePerPerson,
      ownSnapshots,
      omnibus: snap.omnibusLowestPrice,
      nights: offer.nights,
      hotelTermPricesPN: buckets.hotelTermPricesPN,
      localityPricesPN: buckets.localityPricesPN,
      marketPricesPN: buckets.marketPricesPN,
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
    .select({ id: offers.id, country: offers.country })
    .from(offers)
    .where(gte(offers.firstSeenAt, cutoff));
  // Same negative filter as activeRows: excluded countries are muted from the
  // digest, so the "new in 24h" counter must not surface them either.
  const newLast24h = newRows.filter((r) => r.country == null || !excluded.has(r.country)).length;

  const html = formatDigest(top, { activeOffers, newLast24h });

  return { html, itemCount: top.length };
}
