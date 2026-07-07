import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ensureSchema, type Db } from '../src/core/db/index.js';
import { offers, priceSnapshots, sourceRuns } from '../src/core/db/schema.js';
import { ingestOffer } from '../src/core/ingest.js';
import type { NormalizedOffer } from '../src/core/types.js';
import type { Profile } from '../src/core/config.js';
import { createApi, __marketComputeCount } from '../src/web/api.js';

// ---- Fixtures ----------------------------------------------------------

function makeOffer(overrides: Partial<NormalizedOffer> = {}): NormalizedOffer {
  return {
    source: 'invia',
    sourceOfferKey: 'hotel-hot-2026-08-15',
    title: 'Hotel Hot Deal',
    country: 'Řecko',
    locality: 'Kréta',
    stars: 4,
    board: 'AI',
    transport: 'flight',
    departureAirport: 'PRG',
    departureDate: '2026-08-15',
    nights: 7,
    pricePerPerson: 12000,
    priceTotal: 24000,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    omnibusLowestPrice: null,
    tourOperator: 'HappyTours',
    url: 'https://invia.example/hot',
    ...overrides,
  };
}

const LETO_MORE: Profile = {
  enabled: true,
  countries: ['Řecko', 'Turecko', 'Egypt', 'Španělsko'],
  transport: 'flight',
  board: ['AI'],
  departureMonths: [6, 7, 8, 9],
  departureWithinDays: null,
  maxPricePerPerson: 25000,
  minRealDiscountPct: 15,
  notifyNewOffers: false,
};

const PROFILES: Record<string, Profile> = { 'leto-more': LETO_MORE };

const NOW = new Date('2026-07-04T10:00:00.000Z');

/**
 * Seed `n` active market-bucket offers matching the hot offer's bucket
 * (Řecko × month 8 × nights 6-8 × AI × 4★), each at `price`, via the real
 * ingest pipeline so match_key/snapshots are populated exactly like production.
 * Distinct hotel titles → distinct match_keys, so none collapse into a group.
 */
async function seedMarketBucket(db: Db, n: number, price: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await ingestOffer(
      db,
      makeOffer({
        source: 'seed',
        sourceOfferKey: `seed-${i}`,
        title: `Seed Hotel ${i}`,
        departureDate: '2026-08-20',
        pricePerPerson: price,
        url: `https://seed.example/${i}`,
      }),
      NOW,
    );
  }
}

// Build the app, and a fetch-style helper that returns parsed JSON.
function makeClient(db: Db) {
  const app = createApi({ db, profiles: PROFILES, now: () => NOW });
  return async (path: string): Promise<{ status: number; body: any }> => {
    const res = await app.request(`http://local${path}`);
    const body = res.headers.get('content-type')?.includes('application/json')
      ? await res.json()
      : await res.text();
    return { status: res.status, body };
  };
}

describe('web api', () => {
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    await ensureSchema(db);
  });

  describe('/api/offers', () => {
    it('returns active offers with realPct/reference/fake, sparkline, and grouping', async () => {
      // Market bucket ≥8 so the hot offer resolves a market baseline.
      await seedMarketBucket(db, 8, 25000);
      // The hot offer (invia, 12000) and its cross-source twin (skrz, 13500).
      await ingestOffer(db, makeOffer({ source: 'invia', sourceOfferKey: 'invia-k', pricePerPerson: 12000, url: 'https://invia.example/deal' }), NOW);
      await ingestOffer(db, makeOffer({ source: 'skrz', sourceOfferKey: 'skrz-k', pricePerPerson: 13500, url: 'https://skrz.example/deal' }), NOW);
      // An individual (NULL match_key: board unknown) offer, still active.
      await ingestOffer(db, makeOffer({ source: 'cedok', sourceOfferKey: 'cedok-k', title: 'Solo Resort', board: 'unknown', pricePerPerson: 9000, url: 'https://cedok.example/solo' }), NOW);

      const client = makeClient(db);
      const { status, body } = await client('/api/offers');
      expect(status).toBe(200);
      expect(Array.isArray(body.offers)).toBe(true);

      // The invia/skrz twin appears once (cheapest representative = invia@12000),
      // with skrz as an alternative.
      const twin = body.offers.find((o: any) => o.title === 'Hotel Hot Deal');
      expect(twin).toBeDefined();
      expect(twin.source).toBe('invia');
      expect(twin.pricePerPerson).toBe(12000);
      expect(twin.alternatives).toHaveLength(1);
      expect(twin.alternatives[0].source).toBe('skrz');
      expect(twin.alternatives[0].pricePerPerson).toBe(13500);

      // Real discount computed from the market bucket median (25000).
      expect(twin.realPct).toBe(52); // round((25000-12000)/25000*100)
      expect(twin.reference).toBe('market');
      expect(twin.fake).toBe(false);
      expect(twin.sparkline.length).toBeGreaterThan(0);
      expect(twin.sparkline.length).toBeLessThanOrEqual(14);

      // The NULL-match-key offer is individual (no alternatives).
      const solo = body.offers.find((o: any) => o.title === 'Solo Resort');
      expect(solo).toBeDefined();
      expect(solo.alternatives).toHaveLength(0);
    });

    it('filters by country, source, and profile', async () => {
      await ingestOffer(db, makeOffer({ source: 'invia', sourceOfferKey: 'gr', country: 'Řecko', url: 'https://x/gr' }), NOW);
      // Bulharsko is NOT in leto-more's country list, so it's excluded by profile.
      await ingestOffer(db, makeOffer({ source: 'cedok', sourceOfferKey: 'bg', title: 'Bulgar Hotel', country: 'Bulharsko', url: 'https://x/bg' }), NOW);

      const client = makeClient(db);

      const byCountry = await client('/api/offers?country=' + encodeURIComponent('Bulharsko'));
      expect(byCountry.body.offers.every((o: any) => o.country === 'Bulharsko')).toBe(true);
      expect(byCountry.body.offers).toHaveLength(1);

      const bySource = await client('/api/offers?source=invia');
      expect(bySource.body.offers.every((o: any) => o.source === 'invia')).toBe(true);
      expect(bySource.body.offers).toHaveLength(1);

      // profile=leto-more only admits its countries (Řecko in, Bulharsko out).
      const byProfile = await client('/api/offers?profile=leto-more');
      expect(byProfile.body.offers.length).toBeGreaterThan(0);
      expect(byProfile.body.offers.every((o: any) => o.country === 'Řecko')).toBe(true);
    });

    it('filters by minRealPct (needs a market baseline ≥8)', async () => {
      await seedMarketBucket(db, 8, 25000);
      await ingestOffer(db, makeOffer({ source: 'invia', sourceOfferKey: 'deal', pricePerPerson: 12000, url: 'https://x/deal' }), NOW);

      const client = makeClient(db);

      // realPct ≈ 52% → passes a 15% threshold.
      const low = await client('/api/offers?minRealPct=15');
      expect(low.body.offers.some((o: any) => o.title === 'Hotel Hot Deal')).toBe(true);

      // A 90% threshold excludes it.
      const high = await client('/api/offers?minRealPct=90');
      expect(high.body.offers.some((o: any) => o.title === 'Hotel Hot Deal')).toBe(false);
    });

    it('rejects a non-numeric minRealPct with 400 (consistent with :id validation)', async () => {
      const client = makeClient(db);
      const { status, body } = await client('/api/offers?minRealPct=abc');
      expect(status).toBe(400);
      expect(body.error).toBeDefined();
    });

    it('caches: a second identical call does not recompute the market baseline', async () => {
      await seedMarketBucket(db, 8, 25000);
      await ingestOffer(db, makeOffer({ source: 'invia', sourceOfferKey: 'deal', pricePerPerson: 12000, url: 'https://x/deal' }), NOW);

      const client = makeClient(db);
      const before = __marketComputeCount();
      await client('/api/offers');
      const afterFirst = __marketComputeCount();
      expect(afterFirst).toBeGreaterThan(before); // first call computes

      await client('/api/offers');
      const afterSecond = __marketComputeCount();
      expect(afterSecond).toBe(afterFirst); // second identical call is served from cache

      // A different query string is a cache miss and recomputes.
      await client('/api/offers?country=' + encodeURIComponent('Řecko'));
      expect(__marketComputeCount()).toBeGreaterThan(afterSecond);
    });
  });

  describe('/api/offers/:id/history', () => {
    it('returns the snapshot series, median band, and claimed original price', async () => {
      // Two snapshots at different prices → a series of length 2.
      const r1 = await ingestOffer(db, makeOffer({ source: 'invia', sourceOfferKey: 'hist', pricePerPerson: 14000, claimedOriginalPrice: 30000, claimedDiscountPct: 50, url: 'https://x/hist' }), new Date('2026-07-01T10:00:00.000Z'));
      await ingestOffer(db, makeOffer({ source: 'invia', sourceOfferKey: 'hist', pricePerPerson: 12000, claimedOriginalPrice: 30000, claimedDiscountPct: 60, url: 'https://x/hist' }), NOW);

      const client = makeClient(db);
      const { status, body } = await client(`/api/offers/${r1.offerId}/history`);
      expect(status).toBe(200);
      expect(body.offerId).toBe(r1.offerId);
      expect(body.series).toHaveLength(2);
      expect(body.series[0]).toHaveProperty('at');
      expect(body.series[0]).toHaveProperty('price');
      expect(body.series.map((p: any) => p.price)).toEqual([14000, 12000]);
      expect(body.claimedOriginalPrice).toBe(30000);
      expect(typeof body.median).toBe('number');
    });

    it('404s for an unknown offer id', async () => {
      const client = makeClient(db);
      const { status } = await client('/api/offers/9999/history');
      expect(status).toBe(404);
    });
  });

  describe('/api/sources', () => {
    it('returns the latest run per source with a backoff flag', async () => {
      // An old ok run and a newer failed one for the same source → latest wins.
      await db.insert(sourceRuns).values({
        source: 'invia', startedAt: '2026-07-04T06:00:00.000Z', finishedAt: '2026-07-04T06:00:00.000Z',
        offersFound: 10, snapshotsWritten: 5, errorCount: 0, status: 'ok', errorSample: null,
      });
      await db.insert(sourceRuns).values({
        source: 'invia', startedAt: '2026-07-04T08:00:00.000Z', finishedAt: '2026-07-04T08:00:00.000Z',
        offersFound: 0, snapshotsWritten: 0, errorCount: 1, status: 'partial', errorSample: 'backoff',
      });
      // A different blocked source, recent block within 24h → backoff true.
      await db.insert(sourceRuns).values({
        source: 'skrz', startedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(), finishedAt: NOW.toISOString(),
        offersFound: 0, snapshotsWritten: 0, errorCount: 1, status: 'failed', errorSample: 'BLOCKED:Request blocked with status 403',
      });

      const client = makeClient(db);
      const { status, body } = await client('/api/sources');
      expect(status).toBe(200);
      expect(Array.isArray(body.sources)).toBe(true);

      const invia = body.sources.find((s: any) => s.source === 'invia');
      expect(invia).toBeDefined();
      // Latest invia run is the 08:00 one.
      expect(invia.status).toBe('partial');
      expect(invia.startedAt).toBe('2026-07-04T08:00:00.000Z');
      expect(invia.backoff).toBe(false);

      const skrz = body.sources.find((s: any) => s.source === 'skrz');
      expect(skrz.backoff).toBe(true);
    });

    it('backoff flag is FALSE when a newer REAL ok run supersedes an older BLOCKED failure within 24h (reviewer counterexample)', async () => {
      // Oldest → newest: a BLOCKED failure, then a benign backoff bookkeeping row, then a REAL
      // 'ok' run — all within the 24h window. Scanning ALL rows for "any BLOCKED failure in the
      // last 24h" (the old buildSources behavior) would wrongly report backoff=true here; the
      // shared "first non-backoff row decides" algorithm correctly sees the newer ok run and
      // reports backoff=false, matching what run.ts would actually do on the next scan.
      await db.insert(sourceRuns).values({
        source: 'invia',
        startedAt: new Date(NOW.getTime() - 20 * 60 * 60 * 1000).toISOString(),
        finishedAt: new Date(NOW.getTime() - 20 * 60 * 60 * 1000).toISOString(),
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 1,
        status: 'failed',
        errorSample: 'BLOCKED:Request blocked with status 403',
      });
      await db.insert(sourceRuns).values({
        source: 'invia',
        startedAt: new Date(NOW.getTime() - 16 * 60 * 60 * 1000).toISOString(),
        finishedAt: new Date(NOW.getTime() - 16 * 60 * 60 * 1000).toISOString(),
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 0,
        status: 'partial',
        errorSample: 'backoff',
      });
      await db.insert(sourceRuns).values({
        source: 'invia',
        startedAt: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
        finishedAt: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
        offersFound: 10,
        snapshotsWritten: 5,
        errorCount: 0,
        status: 'ok',
        errorSample: null,
      });

      const client = makeClient(db);
      const { status, body } = await client('/api/sources');
      expect(status).toBe(200);

      const invia = body.sources.find((s: any) => s.source === 'invia');
      expect(invia).toBeDefined();
      expect(invia.status).toBe('ok');
      expect(invia.backoff).toBe(false);
    });
  });

  describe('/api/stats', () => {
    it('returns active count, new-24h count, and median price per profile set', async () => {
      // Two active offers matching leto-more (Řecko, AI, flight) plus one that
      // doesn't (Turecko still Řecko-adjacent but profile admits Turecko too, so
      // use a non-matching board to exclude).
      await ingestOffer(db, makeOffer({ source: 'invia', sourceOfferKey: 'a', pricePerPerson: 10000, url: 'https://x/a' }), NOW);
      await ingestOffer(db, makeOffer({ source: 'cedok', sourceOfferKey: 'b', title: 'Other Hotel', pricePerPerson: 20000, url: 'https://x/b' }), NOW);
      // Non-matching (board none → not in leto-more's [AI]).
      await ingestOffer(db, makeOffer({ source: 'der', sourceOfferKey: 'c', title: 'Cheap Bnb', board: 'none', pricePerPerson: 5000, url: 'https://x/c' }), NOW);

      const client = makeClient(db);
      const { status, body } = await client('/api/stats');
      expect(status).toBe(200);
      expect(body.activeCount).toBe(3);
      expect(body.new24h).toBe(3); // all first-seen "now"
      expect(body.medianByProfile).toBeDefined();
      // leto-more set = the two AI/Řecko offers → median of [10000, 20000] = 15000.
      expect(body.medianByProfile['leto-more']).toBe(15000);
    });
  });
});
