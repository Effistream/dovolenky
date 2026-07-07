import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ensureSchema, type Db } from '../src/core/db/index.js';
import { offers, priceSnapshots } from '../src/core/db/schema.js';
import type { NormalizedOffer } from '../src/core/types.js';
import { marketBucketPrices } from '../src/core/market.js';

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
});
