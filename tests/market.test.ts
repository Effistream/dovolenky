import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ensureSchema, type Db } from '../src/core/db/index.js';
import { offers, priceSnapshots } from '../src/core/db/schema.js';
import type { NormalizedOffer } from '../src/core/types.js';
import { marketBucketPrices } from '../src/core/market.js';
import { computeMatchKey } from '../src/core/normalize.js';

// Bucket-defining fields shared by every seeded offer so they all fall in the
// same market bucket (Řecko × month 8 × nights band 6-8 × AI × 4★).
function bucketOffer(overrides: Partial<NormalizedOffer> = {}): NormalizedOffer {
  return {
    source: 'seed',
    sourceOfferKey: 'k',
    title: 'Hotel Bucket',
    country: 'Řecko',
    locality: 'Kréta',
    stars: 4,
    board: 'AI',
    transport: 'flight',
    departureAirport: 'PRG',
    departureDate: '2026-08-15',
    nights: 7,
    pricePerPerson: 20000,
    priceTotal: 40000,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    omnibusLowestPrice: null,
    tourOperator: 'Seed',
    url: 'https://example.com/seed',
    ...overrides,
  };
}

async function seed(
  db: Db,
  opts: { key: string; price: number; matchKey: string | null; at: string },
): Promise<number> {
  const [row] = await db
    .insert(offers)
    .values({
      source: 'seed',
      sourceOfferKey: opts.key,
      title: `Seed ${opts.key}`,
      country: 'Řecko',
      locality: 'Kréta',
      stars: 4,
      board: 'AI',
      transport: 'flight',
      departureAirport: 'PRG',
      departureDate: '2026-08-15',
      nights: 7,
      tourOperator: 'Seed',
      url: `https://example.com/${opts.key}`,
      firstSeenAt: opts.at,
      lastSeenAt: opts.at,
      active: true,
      misses: 0,
      matchKey: opts.matchKey,
    })
    .returning({ id: offers.id });
  await db.insert(priceSnapshots).values({
    offerId: row!.id,
    capturedAt: opts.at,
    pricePerPerson: opts.price,
    priceTotal: opts.price * 2,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    omnibusLowestPrice: null,
  });
  return row!.id;
}

describe('marketBucketPrices cross-source dedup (spec §13)', () => {
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    await ensureSchema(db);
  });

  it('collapses a same-match_key pair to a single MIN(price), keeping NULL-match_key rows individual', async () => {
    const at = '2026-07-04T09:00:00.000Z';

    // Two offers of the SAME physical tour (matchKey 'DUP') at 12000 and 13000.
    await seed(db, { key: 'dup-a', price: 12000, matchKey: 'DUP', at });
    await seed(db, { key: 'dup-b', price: 13000, matchKey: 'DUP', at });

    // Seven distinct others (NULL match_key) at 20000..20006.
    for (let i = 0; i < 7; i += 1) {
      await seed(db, { key: `other-${i}`, price: 20000 + i, matchKey: null, at });
    }

    // The querying offer itself (excluded by ne(offers.id, offerId)).
    const selfId = await seed(db, { key: 'self', price: 15000, matchKey: null, at });

    const prices = await marketBucketPrices(db, selfId, bucketOffer());

    // 7 NULL-key others + 1 MIN of the DUP group = 8 prices; the DUP group
    // contributes 12000 exactly once (13000 dropped).
    expect(prices).toHaveLength(8);
    expect(prices.filter((p) => p === 12000)).toHaveLength(1);
    expect(prices).not.toContain(13000);
    // the seven others are all present
    for (let i = 0; i < 7; i += 1) expect(prices).toContain(20000 + i);
  });

  it("excludes the subject's own cross-listed twin from the market baseline", async () => {
    const at = '2026-07-04T09:00:00.000Z';
    const subject = bucketOffer();
    const subjectKey = computeMatchKey(subject);
    expect(subjectKey).not.toBeNull();

    // The subject offer itself, plus its cross-source twin (different offers.id,
    // same match_key, price ~= subject's own price). Without the fix, the twin
    // would survive group-MIN and bias the baseline toward "no discount".
    const selfId = await seed(db, { key: 'self', price: 15000, matchKey: subjectKey, at });
    const twinId = await seed(db, { key: 'twin', price: 15100, matchKey: subjectKey, at });

    // Eight other distinct offers (NULL match_key) clearly in-bucket.
    for (let i = 0; i < 8; i += 1) {
      await seed(db, { key: `other-${i}`, price: 20000 + i, matchKey: null, at });
    }

    const prices = await marketBucketPrices(db, selfId, subject);

    expect(prices).not.toContain(15100);
    expect(prices).not.toContain(15000);
    expect(prices).toHaveLength(8);
    for (let i = 0; i < 8; i += 1) expect(prices).toContain(20000 + i);

    // Sanity: the twin row is truly a separate offer id from the subject.
    expect(twinId).not.toBe(selfId);
  });

  it('NULL subject match_key leaves behavior unchanged (twin-like row remains included)', async () => {
    const at = '2026-07-04T09:00:00.000Z';
    // Title of only stopwords ('Hotel') makes computeMatchKey's canonName empty,
    // so it returns null for the subject — while country/board/stars/dates stay
    // normal, so the bucket membership itself is unaffected.
    const subject = bucketOffer({ title: 'Hotel' });
    expect(computeMatchKey(subject)).toBeNull();

    const selfId = await seed(db, { key: 'self', price: 15000, matchKey: null, at });
    // A row that looks like a cross-source "twin" (same price ballpark, some
    // match_key) but since the subject's own key is null, no match_key-based
    // exclusion applies — it must be counted just like any other bucket row.
    await seed(db, { key: 'twin-like', price: 15100, matchKey: 'SOME-OTHER-KEY', at });

    for (let i = 0; i < 8; i += 1) {
      await seed(db, { key: `other-${i}`, price: 20000 + i, matchKey: null, at });
    }

    const prices = await marketBucketPrices(db, selfId, subject);

    expect(prices).toContain(15100);
    expect(prices).toHaveLength(9);
    for (let i = 0; i < 8; i += 1) expect(prices).toContain(20000 + i);
  });
});
