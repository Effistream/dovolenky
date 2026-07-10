import { Hono } from 'hono';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../core/db/index.js';
import { offers, priceSnapshots, sourceRuns } from '../core/db/schema.js';
import type { Profile } from '../core/config.js';
import type { NormalizedOffer, Board, Transport } from '../core/types.js';
import { computeRealDiscount, median, type DiscountResult } from '../core/discount.js';
import { bucketPricesInMemory, type ActiveOfferLite } from '../core/market.js';
import { matchProfiles } from '../core/filters.js';
import { RECENT_RUN_SCAN_LIMIT, backoffUntilFrom } from '../core/backoff.js';
import { getExcludedCountries, setExcludedCountries } from '../core/db/exclusions.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SPARKLINE_POINTS = 14;
const HISTORY_MEDIAN_DAYS = 30;
const MAX_ALTERNATIVES = 3;
// Own-history window for the discount ladder's "own" tier + the sparkline source.
// Matches market.ts OWN_WINDOW_DAYS (ownSnapshotsFor) so the board's own-baseline
// is computed over exactly the same window a Telegram notification would use.
const OWN_HISTORY_DAYS = 30;
// 1 h. Each cache miss recomputes buildOffers, whose bulk snapshot loads read on
// the order of the whole price_snapshots table — the main lever on Turso's
// rows-read quota. The scan only writes every ~2h, so a longer TTL mostly skips
// redundant recomputation of identical data (board is ≤1h stale; Telegram remains
// the instant channel for hot deals).
const CACHE_TTL_MS = 60 * 60 * 1000;
// Upper bound on source_runs rows read by /api/sources (see buildSources). 1000 ≫
// 16 sources × RECENT_RUN_SCAN_LIMIT, so it always covers every source's recent runs.
const SOURCE_RUNS_READ_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Test observability: a module-level counter incremented once per market-bucket
// computation. Tests read it via __marketComputeCount() to prove the in-memory
// cache serves a repeated identical query without recomputing (there is no
// listening server to time, and mocking market.ts across an ESM boundary is
// heavier than this one counter). Not part of the public HTTP surface.
// ---------------------------------------------------------------------------
let marketComputeCount = 0;
export function __marketComputeCount(): number {
  return marketComputeCount;
}

export interface CreateApiOptions {
  db: Db;
  profiles: Record<string, Profile>;
  /** Injectable clock (tests pin it); defaults to real time. */
  now?: () => Date;
}

/** Reconstruct a NormalizedOffer from an offers row + a price snapshot. */
function rowToOffer(
  row: typeof offers.$inferSelect,
  snap: { pricePerPerson: number; priceTotal: number | null; claimedOriginalPrice: number | null; claimedDiscountPct: number | null; omnibusLowestPrice: number | null },
): NormalizedOffer {
  return {
    source: row.source,
    sourceOfferKey: row.sourceOfferKey,
    title: row.title,
    country: row.country,
    locality: row.locality,
    stars: row.stars,
    board: (row.board ?? 'unknown') as Board,
    transport: (row.transport ?? 'unknown') as Transport,
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
}

/** The subset of a price snapshot the board needs (latest per offer). */
interface LatestSnap {
  pricePerPerson: number;
  priceTotal: number | null;
  claimedOriginalPrice: number | null;
  claimedDiscountPct: number | null;
  omnibusLowestPrice: number | null;
}

/**
 * Latest snapshot for every ACTIVE offer, in a single query (max(id) per
 * offer_id, joined back to its row, restricted to active offers). Replaces the
 * per-row latestSnapshot loop and the per-representative rebuild; its price-only
 * projection also feeds bucketPricesInMemory (the reference ladder) so no
 * per-bucket-row snapshot query is needed. No writes happen during a read, so the
 * map is consistent for the whole request.
 */
async function loadLatestSnapshots(db: Db): Promise<Map<number, LatestSnap>> {
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
 * All price snapshots from the last `windowDays` days, grouped by offer id and
 * ordered oldest→newest within each offer. One bulk query that serves BOTH the
 * own-history baseline (computeRealDiscount medians the full 30-day window) and
 * the sparkline (last SPARKLINE_POINTS by id) — so the read path never issues a
 * per-representative snapshot query. Active offers are seen recently, so their
 * latest writes fall inside this window.
 */
async function loadRecentSnapshots(db: Db, now: Date, windowDays: number): Promise<Map<number, { price: number; at: string }[]>> {
  const sinceIso = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const rows = await db
    .select({ offerId: priceSnapshots.offerId, price: priceSnapshots.pricePerPerson, at: priceSnapshots.capturedAt })
    .from(priceSnapshots)
    .where(gte(priceSnapshots.capturedAt, sinceIso))
    .orderBy(priceSnapshots.offerId, priceSnapshots.id);

  const map = new Map<number, { price: number; at: string }[]>();
  for (const r of rows) {
    let list = map.get(r.offerId);
    if (!list) { list = []; map.set(r.offerId, list); }
    list.push({ price: r.price, at: r.at });
  }
  return map;
}

interface OfferItem {
  id: number;
  source: string;
  title: string;
  country: string | null;
  locality: string | null;
  stars: number | null;
  board: Board;
  transport: Transport;
  departureAirport: string | null;
  departureDate: string | null;
  nights: number | null;
  pricePerPerson: number;
  priceTotal: number | null;
  claimedOriginalPrice: number | null;
  claimedDiscountPct: number | null;
  tourOperator: string | null;
  url: string;
  realPct: number | null;
  reference: DiscountResult['reference'];
  baseline: number | null;
  fake: boolean;
  alternatives: { source: string; pricePerPerson: number; url: string }[];
  sparkline: number[];
}

/**
 * Build the /api/offers payload: every active offer, grouped by match_key into a
 * cheapest representative (mirrors notify.ts groupCandidates + digest.ts market
 * dedup, but over DB rows), each carrying realPct/reference/fake from
 * computeRealDiscount, the pricier peers as `alternatives`, and the last 14
 * snapshot prices as a sparkline. Filtering (country/source/profile/minRealPct)
 * is applied here so the cache key can be the raw query string.
 */
async function buildOffers(
  db: Db,
  profiles: Record<string, Profile>,
  now: Date,
  filters: { profile?: string; country?: string; source?: string; minRealPct?: number },
): Promise<OfferItem[]> {
  const activeRowsRaw = await db.select().from(offers).where(eq(offers.active, true));
  const excluded = new Set(await getExcludedCountries(db));
  const activeRows = activeRowsRaw.filter((r) => r.country == null || !excluded.has(r.country));

  // A handful of bulk queries; the rest is in memory. The per-representative
  // discount ladder used to issue ~5 queries each (3 reference buckets + own
  // history + sparkline). Against remote Turso the HTTP client does not pipeline
  // those, so hundreds of representatives serialized into >200s. Now: latest
  // snapshot per active offer, plus the last OWN_HISTORY_DAYS of snapshots
  // (own-history baseline + sparkline). Bucket membership is filtered in memory.
  const snapByOfferId = await loadLatestSnapshots(db);
  const recentByOfferId = await loadRecentSnapshots(db, now, OWN_HISTORY_DAYS);

  const latestPriceByOfferId = new Map<number, number>();
  for (const [id, s] of snapByOfferId) latestPriceByOfferId.set(id, s.pricePerPerson);

  // Lightweight view of the FULL active set for in-memory bucket membership. Note
  // it is built from activeRowsRaw (before the excluded-country filter): excluded
  // countries drop off the board but still count as reference-bucket peers, exactly
  // as the SQL bucket queries (which filter only on active=true) did.
  const activeLites: ActiveOfferLite[] = activeRowsRaw.map((r) => ({
    id: r.id,
    country: r.country,
    locality: r.locality,
    board: r.board,
    stars: r.stars,
    nights: r.nights,
    departureDate: r.departureDate,
    matchKey: r.matchKey,
    hotelKey: r.hotelKey,
  }));

  // Group by match_key. NULL match_key → each row is its own group. The cheapest
  // row is the representative; the rest become price-ascending alternatives.
  const withSnap: { row: typeof offers.$inferSelect; snap: LatestSnap }[] = [];
  for (const row of activeRows) {
    const snap = snapByOfferId.get(row.id);
    if (snap) withSnap.push({ row, snap });
  }

  const groups = new Map<string, { row: typeof offers.$inferSelect; snap: LatestSnap }[]>();
  const order: string[] = [];
  withSnap.forEach((entry, i) => {
    const key = entry.row.matchKey != null ? `k:${entry.row.matchKey}` : `u:${i}`;
    const existing = groups.get(key);
    if (existing) existing.push(entry);
    else {
      groups.set(key, [entry]);
      order.push(key);
    }
  });

  const items: OfferItem[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    const sorted = [...group].sort((a, b) => a.snap.pricePerPerson - b.snap.pricePerPerson);
    const rep = sorted[0]!;
    const alternatives = sorted
      .slice(1, 1 + MAX_ALTERNATIVES)
      .map((e) => ({ source: e.row.source, pricePerPerson: e.snap.pricePerPerson, url: e.row.url }));

    const offer = rowToOffer(rep.row, rep.snap);

    // Filters that don't need the discount are cheapest to apply first.
    if (filters.source && offer.source !== filters.source) continue;
    if (filters.country && offer.country !== filters.country) continue;
    if (filters.profile) {
      const matched = matchProfiles(offer, profiles, now).some((m) => m.name === filters.profile);
      if (!matched) continue;
    }

    marketComputeCount += 1;
    // Own history (last OWN_HISTORY_DAYS) + the per-night reference ladder (spec
    // §15: hotel → locality → market), all in memory from the preloaded maps.
    const ownSnapshots = recentByOfferId.get(rep.row.id) ?? [];
    const { hotelTermPricesPN, localityPricesPN, marketPricesPN } = bucketPricesInMemory(
      rep.row.id,
      offer,
      activeLites,
      latestPriceByOfferId,
    );
    const discount = computeRealDiscount({
      current: offer.pricePerPerson,
      ownSnapshots,
      omnibus: offer.omnibusLowestPrice,
      nights: offer.nights,
      hotelTermPricesPN,
      localityPricesPN,
      marketPricesPN,
      claimedPct: offer.claimedDiscountPct,
      now,
    });

    if (filters.minRealPct != null && (discount.realPct == null || discount.realPct < filters.minRealPct)) {
      continue;
    }

    // Sparkline = last SPARKLINE_POINTS snapshot prices, oldest→newest (the recent
    // list is already id-ascending).
    const sparkline = ownSnapshots.slice(-SPARKLINE_POINTS).map((s) => s.price);

    items.push({
      id: rep.row.id,
      source: offer.source,
      title: offer.title,
      country: offer.country,
      locality: offer.locality,
      stars: offer.stars,
      board: offer.board,
      transport: offer.transport,
      departureAirport: offer.departureAirport,
      departureDate: offer.departureDate,
      nights: offer.nights,
      pricePerPerson: offer.pricePerPerson,
      priceTotal: offer.priceTotal,
      claimedOriginalPrice: offer.claimedOriginalPrice,
      claimedDiscountPct: offer.claimedDiscountPct,
      tourOperator: offer.tourOperator,
      url: offer.url,
      realPct: discount.realPct,
      reference: discount.reference,
      baseline: discount.baseline,
      fake: discount.fake,
      alternatives,
      sparkline,
    });
  }

  // Sort by real discount desc (nulls last) — the board's default ordering.
  items.sort((a, b) => {
    if (a.realPct == null && b.realPct == null) return 0;
    if (a.realPct == null) return 1;
    if (b.realPct == null) return -1;
    return b.realPct - a.realPct;
  });

  return items;
}

/**
 * Latest source_run per source + a backoff flag. The backoff flag uses the same
 * "first non-backoff row decides" algorithm as run.ts's blockedBackoffUntil (via the shared
 * backoff.ts#backoffUntilFrom): a more recent REAL (non-backoff) run — even an 'ok' one —
 * supersedes an older BLOCKED failure, so the flag never diverges from what the scanner
 * actually does on the next run.
 */
async function buildSources(db: Db, now: Date) {
  // source_runs grows unbounded (~one row per source per scan). We only need the
  // latest run per source plus its recent runs for the backoff flag
  // (RECENT_RUN_SCAN_LIMIT=20 each), so read the most recent N globally rather than
  // the whole table — every source scans each run, so ~16 sources fit many times
  // over in 1000 rows, keeping this off Turso's rows-read quota as history grows.
  const rows = await db
    .select()
    .from(sourceRuns)
    .orderBy(desc(sourceRuns.id))
    .limit(SOURCE_RUNS_READ_LIMIT);

  // Rows per source, newest-first (preserved from the id-desc query order).
  const bySource = new Map<string, typeof sourceRuns.$inferSelect[]>();
  for (const row of rows) {
    const list = bySource.get(row.source);
    if (list) list.push(row);
    else bySource.set(row.source, [row]);
  }

  const nowMs = now.getTime();
  return [...bySource.entries()].map(([source, sourceRows]) => {
    const latest = sourceRows[0]!;
    const liftsAt = backoffUntilFrom(sourceRows.slice(0, RECENT_RUN_SCAN_LIMIT), nowMs);
    return {
      source,
      status: latest.status,
      startedAt: latest.startedAt,
      finishedAt: latest.finishedAt,
      offersFound: latest.offersFound,
      snapshotsWritten: latest.snapshotsWritten,
      errorCount: latest.errorCount,
      errorSample: latest.errorSample,
      backoff: liftsAt != null,
    };
  });
}

/** Active count, new-in-24h count, and median latest price per profile-matching set. */
async function buildStats(db: Db, profiles: Record<string, Profile>, now: Date) {
  const activeRowsRaw = await db.select().from(offers).where(eq(offers.active, true));
  const excluded = new Set(await getExcludedCountries(db));
  const activeRows = activeRowsRaw.filter((r) => r.country == null || !excluded.has(r.country));
  const activeCount = activeRows.length;

  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const newRows = await db.select({ id: offers.id, country: offers.country }).from(offers).where(gte(offers.firstSeenAt, cutoff));
  const new24h = newRows.filter((r) => r.country == null || !excluded.has(r.country)).length;

  // Median latest price per profile: reuse matchProfiles over the reconstructed
  // offer so the "set" is exactly what each profile would notify on. One bulk
  // load of latest snapshots (same as the board) replaces the per-row N+1.
  const pricesByProfile = new Map<string, number[]>();
  for (const name of Object.keys(profiles)) pricesByProfile.set(name, []);

  const snapByOfferId = await loadLatestSnapshots(db);
  for (const row of activeRows) {
    const snap = snapByOfferId.get(row.id);
    if (!snap) continue;
    const offer = rowToOffer(row, snap);
    for (const m of matchProfiles(offer, profiles, now)) {
      pricesByProfile.get(m.name)?.push(snap.pricePerPerson);
    }
  }

  const medianByProfile: Record<string, number | null> = {};
  for (const [name, prices] of pricesByProfile) {
    medianByProfile[name] = prices.length > 0 ? median(prices) : null;
  }

  return { activeCount, new24h, medianByProfile };
}

/**
 * Price history for a single offer: the full snapshot series (oldest→newest),
 * a median band over the last 30 days, and the latest claimed "original" price
 * (for the red dashed "za tu se neprodávalo" line in the detail chart).
 */
async function buildHistory(db: Db, offerId: number, now: Date) {
  const [row] = await db.select().from(offers).where(eq(offers.id, offerId)).limit(1);
  if (!row) return null;

  const snaps = await db
    .select()
    .from(priceSnapshots)
    .where(eq(priceSnapshots.offerId, offerId))
    .orderBy(priceSnapshots.id);

  const series = snaps.map((s) => ({ at: s.capturedAt, price: s.pricePerPerson }));

  const windowStart = new Date(now.getTime() - HISTORY_MEDIAN_DAYS * DAY_MS).getTime();
  const bandPrices = snaps
    .filter((s) => {
      const t = new Date(s.capturedAt).getTime();
      return Number.isFinite(t) && t >= windowStart;
    })
    .map((s) => s.pricePerPerson);

  const latest = snaps.length > 0 ? snaps[snaps.length - 1]! : null;

  return {
    offerId,
    title: row.title,
    series,
    median: bandPrices.length > 0 ? median(bandPrices) : null,
    claimedOriginalPrice: latest?.claimedOriginalPrice ?? null,
  };
}

// ---------------------------------------------------------------------------
// In-memory cache: a single Map keyed by the full request query string
// (path + search). TTL 5 minutes. Process-local only — cleared on restart, not
// shared across processes, and never invalidated on writes (the scanner writes
// out-of-band; a stale window ≤5 min is acceptable per spec §14). The N+1
// market-bucket computation is what this cache is protecting.
// ---------------------------------------------------------------------------
interface CacheEntry {
  at: number;
  payload: unknown;
}

export function createApi(opts: CreateApiOptions) {
  const { db, profiles } = opts;
  const now = opts.now ?? (() => new Date());
  const cache = new Map<string, CacheEntry>();

  async function cached(key: string, compute: () => Promise<unknown>): Promise<unknown> {
    const hit = cache.get(key);
    if (hit && now().getTime() - hit.at < CACHE_TTL_MS) return hit.payload;
    const payload = await compute();
    cache.set(key, { at: now().getTime(), payload });
    return payload;
  }

  const app = new Hono();

  app.get('/api/offers', async (c) => {
    const url = new URL(c.req.url);
    const q = url.searchParams;
    const minRealPctRaw = q.get('minRealPct');
    let minRealPct: number | undefined;
    if (minRealPctRaw != null && minRealPctRaw !== '') {
      minRealPct = Number(minRealPctRaw);
      if (!Number.isFinite(minRealPct)) return c.json({ error: 'invalid minRealPct' }, 400);
    }
    const key = `offers?${url.searchParams.toString()}`;
    const filters = {
      profile: q.get('profile') ?? undefined,
      country: q.get('country') ?? undefined,
      source: q.get('source') ?? undefined,
      minRealPct,
    };
    const payload = await cached(key, async () => ({ offers: await buildOffers(db, profiles, now(), filters) }));
    return c.json(payload);
  });

  app.get('/api/offers/:id/history', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    const payload = await cached(`history/${id}`, () => buildHistory(db, id, now()));
    if (payload == null) return c.json({ error: 'not found' }, 404);
    return c.json(payload);
  });

  app.get('/api/sources', async (c) => {
    const payload = await cached('sources', async () => ({ sources: await buildSources(db, now()) }));
    return c.json(payload);
  });

  app.get('/api/stats', async (c) => {
    const payload = await cached('stats', () => buildStats(db, profiles, now()));
    return c.json(payload);
  });

  app.get('/api/exclusions', async (c) => {
    return c.json({ countries: await getExcludedCountries(db) });
  });

  app.put('/api/exclusions', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const countries = (body as { countries?: unknown })?.countries;
    if (!Array.isArray(countries) || !countries.every((x) => typeof x === 'string')) {
      return c.json({ error: 'countries must be string[]' }, 400);
    }
    const stored = await setExcludedCountries(db, countries);
    cache.clear(); // exclusions change the offers/stats sets → drop the 5-min cache
    return c.json({ countries: stored });
  });

  return app;
}
