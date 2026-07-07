import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ensureSchema, type Db } from '../src/core/db/index.js';
import { offers, priceSnapshots } from '../src/core/db/schema.js';
import type { NormalizedOffer } from '../src/core/types.js';
import { hotelTermPricesPN, localityBucketPricesPN, marketBucketPrices } from '../src/core/market.js';
import { computeHotelKey, computeMatchKey } from '../src/core/normalize.js';

// Every seeded market-bucket offer has nights=7, so marketBucketPrices returns
// per-NIGHT prices = round(price / 7). PN() makes the expectations self-documenting.
const PN = (total: number, nights = 7): number => Math.round(total / nights);

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

describe('marketBucketPrices cross-source dedup (spec §13) + per-night (spec §15)', () => {
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    await ensureSchema(db);
  });

  it('collapses a same-match_key pair to a single MIN(per-night), keeping NULL-match_key rows individual', async () => {
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
    // contributes PN(12000) exactly once (PN(13000) dropped).
    expect(prices).toHaveLength(8);
    expect(prices.filter((p) => p === PN(12000))).toHaveLength(1);
    expect(prices).not.toContain(PN(13000));
    // the seven others are all present, per-night
    for (let i = 0; i < 7; i += 1) expect(prices).toContain(PN(20000 + i));
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

    expect(prices).not.toContain(PN(15100));
    expect(prices).not.toContain(PN(15000));
    expect(prices).toHaveLength(8);
    for (let i = 0; i < 8; i += 1) expect(prices).toContain(PN(20000 + i));

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

    expect(prices).toContain(PN(15100));
    expect(prices).toHaveLength(9);
    for (let i = 0; i < 8; i += 1) expect(prices).toContain(PN(20000 + i));
  });

  it('returns per-NIGHT values (price / nights), not whole-stay totals', async () => {
    const at = '2026-07-04T09:00:00.000Z';
    // A subject at nights=7 querying a bucket where the ONLY other row is a
    // 7-night stay at 14000 total → 2000/night.
    const selfId = await seed(db, { key: 'self', price: 21000, matchKey: null, at });
    await seed(db, { key: 'other', price: 14000, matchKey: null, at });

    const prices = await marketBucketPrices(db, selfId, bucketOffer());
    expect(prices).toEqual([2000]); // 14000 / 7, not 14000
  });
});

// A richer seed that lets a test vary the fields the hotel/locality buckets key
// on (title/hotelKey, board, nights, departureDate, locality, stars). hotel_key
// is derived from the row exactly like ingest does, so hotelTermPricesPN's
// hotel_key match works.
async function seedFull(
  db: Db,
  opts: {
    key: string;
    price: number;
    at: string;
    title?: string;
    country?: string | null;
    locality?: string | null;
    stars?: number | null;
    board?: NormalizedOffer['board'];
    departureDate?: string | null;
    nights?: number | null;
    matchKey?: string | null;
  },
): Promise<number> {
  const title = opts.title ?? 'Hotel Bucket';
  const country = opts.country === undefined ? 'Řecko' : opts.country;
  const rowOffer = bucketOffer({ title, country: country ?? null });
  const hotelKey = computeHotelKey(rowOffer);
  const [row] = await db
    .insert(offers)
    .values({
      source: 'seed',
      sourceOfferKey: opts.key,
      title,
      country: country ?? null,
      locality: opts.locality === undefined ? 'Kréta' : opts.locality,
      stars: opts.stars === undefined ? 4 : opts.stars,
      board: opts.board ?? 'AI',
      transport: 'flight',
      departureAirport: 'PRG',
      departureDate: opts.departureDate === undefined ? '2026-08-15' : opts.departureDate,
      nights: opts.nights === undefined ? 7 : opts.nights,
      tourOperator: 'Seed',
      url: `https://example.com/${opts.key}`,
      firstSeenAt: opts.at,
      lastSeenAt: opts.at,
      active: true,
      misses: 0,
      matchKey: opts.matchKey ?? null,
      hotelKey,
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

describe('hotelTermPricesPN (spec §15 hotel rung)', () => {
  let db: Db;
  const at = '2026-07-04T09:00:00.000Z';

  beforeEach(async () => {
    db = openDb(':memory:');
    await ensureSchema(db);
  });

  it('returns per-night prices of other terms of the same hotel; excludes twin, self, out-of-window and wrong-board', async () => {
    // Subject: "Hotel Alfa", Řecko, AI, 7 nights, depart 2026-08-15.
    const subject = bucketOffer({ title: 'Hotel Alfa' });
    const selfId = await seedFull(db, { key: 'self', title: 'Hotel Alfa', price: 14000, at, nights: 7 });

    // 5 in-window terms of the SAME hotel (nights within ±2, date within ±30d, AI).
    await seedFull(db, { key: 't1', title: 'Hotel Alfa', price: 14000, at, nights: 7, departureDate: '2026-08-15' }); // 2000/n
    await seedFull(db, { key: 't2', title: 'Hotel Alfa', price: 12000, at, nights: 6, departureDate: '2026-08-20' }); // 2000/n
    await seedFull(db, { key: 't3', title: 'Hotel Alfa', price: 18000, at, nights: 9, departureDate: '2026-08-01' }); // 2000/n
    await seedFull(db, { key: 't4', title: 'Hotel Alfa', price: 16000, at, nights: 8, departureDate: '2026-09-10' }); // 2000/n
    await seedFull(db, { key: 't5', title: 'Hotel Alfa', price: 10000, at, nights: 5, departureDate: '2026-07-20' }); // 2000/n

    // Out-of-window (date > +30d): excluded.
    await seedFull(db, { key: 'far', title: 'Hotel Alfa', price: 99999, at, nights: 7, departureDate: '2026-10-15' });
    // Nights out of ±2: excluded.
    await seedFull(db, { key: 'long', title: 'Hotel Alfa', price: 99999, at, nights: 12, departureDate: '2026-08-15' });
    // Different board: excluded.
    await seedFull(db, { key: 'board', title: 'Hotel Alfa', price: 99999, at, nights: 7, departureDate: '2026-08-15', board: 'HB' });
    // Different hotel (different hotel_key): excluded.
    await seedFull(db, { key: 'other-hotel', title: 'Hotel Beta', price: 99999, at, nights: 7, departureDate: '2026-08-15' });
    // Cross-source twin of the subject (same match_key): excluded.
    const subjectKey = computeMatchKey(subject)!;
    await seedFull(db, { key: 'twin', title: 'Hotel Alfa', price: 14100, at, nights: 7, departureDate: '2026-08-15', matchKey: subjectKey });

    const prices = await hotelTermPricesPN(db, selfId, subject);

    // Only the 5 valid same-hotel terms, each 2000/night; twin/self/out-of-window
    // /wrong-board/other-hotel all excluded (none of the 99999 or 14100 leak in).
    expect(prices).toHaveLength(5);
    expect(prices.every((p) => p === 2000)).toBe(true);
    expect(prices).not.toContain(Math.round(99999 / 7));
  });

  it('returns [] when the subject hotel_key is null (all-stopword title)', async () => {
    const subject = bucketOffer({ title: 'Hotel' }); // canonName empty → hotelKey null
    expect(computeHotelKey(subject)).toBeNull();
    const selfId = await seedFull(db, { key: 'self', title: 'Hotel', price: 14000, at });
    // A same-titled sibling exists, but a null hotel_key opts the subject out entirely.
    await seedFull(db, { key: 's1', title: 'Hotel', price: 12000, at });
    const prices = await hotelTermPricesPN(db, selfId, subject);
    expect(prices).toEqual([]);
  });

  it('returns [] when subject nights or departureDate is null (no comparison window)', async () => {
    const noNights = bucketOffer({ title: 'Hotel Alfa', nights: null });
    const selfA = await seedFull(db, { key: 'a', title: 'Hotel Alfa', price: 14000, at, nights: null });
    expect(await hotelTermPricesPN(db, selfA, noNights)).toEqual([]);

    const noDate = bucketOffer({ title: 'Hotel Alfa', departureDate: null });
    const selfB = await seedFull(db, { key: 'b', title: 'Hotel Alfa', price: 14000, at, departureDate: null });
    expect(await hotelTermPricesPN(db, selfB, noDate)).toEqual([]);
  });
});

describe('localityBucketPricesPN (spec §15 locality rung)', () => {
  let db: Db;
  const at = '2026-07-04T09:00:00.000Z';

  beforeEach(async () => {
    db = openDb(':memory:');
    await ensureSchema(db);
  });

  it('returns per-night prices of the locality×month×board×stars bucket (≥8), excluding self, twin and different locality', async () => {
    const subject = bucketOffer(); // Kréta, Řecko, AI, 4★, 2026-08-15
    const selfId = await seedFull(db, { key: 'self', title: 'Hotel Alfa', price: 21000, at });

    // 8 in-bucket offers (Kréta, month 08, AI, 4★) — nights VARY, so per-night
    // matters; all normalize to 2000/night.
    await seedFull(db, { key: 'l1', title: 'Hotel B1', price: 14000, at, nights: 7, departureDate: '2026-08-10' });
    await seedFull(db, { key: 'l2', title: 'Hotel B2', price: 12000, at, nights: 6, departureDate: '2026-08-12' });
    await seedFull(db, { key: 'l3', title: 'Hotel B3', price: 16000, at, nights: 8, departureDate: '2026-08-14' });
    await seedFull(db, { key: 'l4', title: 'Hotel B4', price: 20000, at, nights: 10, departureDate: '2026-08-16' });
    await seedFull(db, { key: 'l5', title: 'Hotel B5', price: 10000, at, nights: 5, departureDate: '2026-08-18' });
    await seedFull(db, { key: 'l6', title: 'Hotel B6', price: 24000, at, nights: 12, departureDate: '2026-08-20' });
    await seedFull(db, { key: 'l7', title: 'Hotel B7', price: 18000, at, nights: 9, departureDate: '2026-08-22' });
    await seedFull(db, { key: 'l8', title: 'Hotel B8', price: 8000, at, nights: 4, departureDate: '2026-08-24' });

    // Different locality (same month/board/stars): excluded.
    await seedFull(db, { key: 'rhodos', title: 'Hotel R', price: 99999, at, locality: 'Rhodos', departureDate: '2026-08-15' });
    // Different month: excluded.
    await seedFull(db, { key: 'july', title: 'Hotel J', price: 99999, at, departureDate: '2026-07-15' });
    // Cross-source twin of the subject: excluded.
    const subjectKey = computeMatchKey(subject)!;
    await seedFull(db, { key: 'twin', title: 'Hotel Alfa', price: 21100, at, matchKey: subjectKey });

    const prices = await localityBucketPricesPN(db, selfId, subject);

    expect(prices).toHaveLength(8);
    expect(prices.every((p) => p === 2000)).toBe(true);
    expect(prices).not.toContain(Math.round(99999 / 7));
  });

  it('returns [] when the subject locality is null', async () => {
    const subject = bucketOffer({ locality: null });
    const selfId = await seedFull(db, { key: 'self', price: 21000, at, locality: null });
    for (let i = 0; i < 8; i += 1) {
      await seedFull(db, { key: `n-${i}`, title: `Hotel N${i}`, price: 14000, at, locality: null });
    }
    expect(await localityBucketPricesPN(db, selfId, subject)).toEqual([]);
  });

  it('skips a bucket row whose nights is null (cannot normalize per-night)', async () => {
    const subject = bucketOffer();
    const selfId = await seedFull(db, { key: 'self', price: 21000, at });
    await seedFull(db, { key: 'ok', title: 'Hotel OK', price: 14000, at, nights: 7 }); // 2000/n
    await seedFull(db, { key: 'null-n', title: 'Hotel Null', price: 14000, at, nights: null }); // skipped

    const prices = await localityBucketPricesPN(db, selfId, subject);
    expect(prices).toEqual([2000]); // only the nights-known row survives
  });
});
