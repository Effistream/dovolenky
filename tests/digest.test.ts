import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ensureSchema, type Db } from '../src/core/db/index.js';
import { offers, priceSnapshots } from '../src/core/db/schema.js';
import type { AppConfig, Profile } from '../src/core/config.js';
import { buildDigest } from '../src/core/digest.js';

// ---- Fixtures ----------------------------------------------------------

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

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    profiles: { 'leto-more': LETO_MORE },
    notifications: {
      priceDropPct: 10,
      renotifyDropPct: 5,
      renotifyAfterDays: 7,
      maxMessagesPerRun: 20,
      digestHour: 8,
    },
    scan: { adults: 2, minRequestGapMs: 0 },
    telegramToken: 'tok',
    telegramChatId: 'chat',
    databaseUrl: ':memory:',
    ...overrides,
  };
}

/**
 * Seeds `n` active offers all in the same market bucket (Řecko × month 8 ×
 * nights band 6-8 × AI × 4★), each with a distinct price so realPct varies
 * once a market median forms across them. Also seeds a 30-day-old snapshot
 * for the first offer at a fixed high price, establishing a stable "market"
 * baseline that the cheaper offers discount against.
 */
async function seedOffer(
  db: Db,
  opts: { key: string; price: number; firstSeenAt: string; capturedAt: string; matchKey?: string | null; title?: string },
): Promise<number> {
  const [row] = await db
    .insert(offers)
    .values({
      source: 'seed',
      sourceOfferKey: opts.key,
      title: opts.title ?? `Seed Hotel ${opts.key}`,
      country: 'Řecko',
      locality: 'Kréta',
      stars: 4,
      board: 'AI',
      transport: 'flight',
      departureAirport: 'PRG',
      departureDate: '2026-08-20',
      nights: 7,
      tourOperator: 'Seed',
      url: `https://example.com/${opts.key}`,
      firstSeenAt: opts.firstSeenAt,
      lastSeenAt: opts.capturedAt,
      active: true,
      misses: 0,
      matchKey: opts.matchKey ?? null,
    })
    .returning({ id: offers.id });
  await db.insert(priceSnapshots).values({
    offerId: row!.id,
    capturedAt: opts.capturedAt,
    pricePerPerson: opts.price,
    priceTotal: opts.price * 2,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    omnibusLowestPrice: null,
  });
  return row!.id;
}

describe('buildDigest', () => {
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    await ensureSchema(db);
  });

  it('returns null when there are no active offers', async () => {
    const result = await buildDigest(db, makeConfig(), new Date('2026-07-04T10:00:00.000Z'));
    expect(result).toBeNull();
  });

  it('builds top-10 by realPct desc, with stats and correct itemCount, from ~15 seeded offers', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const oldAt = '2026-06-01T09:00:00.000Z'; // >24h before now, so not "new"
    const newAt = '2026-07-04T08:00:00.000Z'; // <24h before now, so "new"

    // 14 offers priced high (20000-20013), all in the same market bucket, old.
    for (let i = 0; i < 14; i += 1) {
      await seedOffer(db, { key: `high-${i}`, price: 20000 + i, firstSeenAt: oldAt, capturedAt: oldAt });
    }

    // 1 offer priced very low (5000) — biggest discount vs. the market median
    // formed by the 14 high-priced offers. Also "new" (seen within 24h).
    await seedOffer(db, { key: 'cheap', price: 5000, firstSeenAt: newAt, capturedAt: newAt });

    const result = await buildDigest(db, makeConfig(), now);
    expect(result).not.toBeNull();
    const { html, itemCount } = result!;

    // 15 active offers total; only 10 rendered in the digest body.
    expect(itemCount).toBe(10);
    expect(html).toContain('Seed Hotel cheap');
    expect(html).toContain('☀️');

    // The first listed item (top of the digest) must be the cheap/biggest-discount one.
    const firstIdx = html.indexOf('Seed Hotel cheap');
    const anyHighIdx = html.indexOf('Seed Hotel high-0');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(anyHighIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(anyHighIdx);

    // Stats line: 15 active offers, 1 new in the last 24h.
    expect(html).toContain('Aktivních nabídek: 15');
    expect(html).toContain('Nových za 24 h: 1');
  });

  it('cross-source dedup: a same-match_key duplicate pair appears once, showing the cheaper representative (spec §13)', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const at = '2026-06-01T09:00:00.000Z';

    // Two sources of the SAME physical tour (matchKey 'DUP'): the pricier "Expensive"
    // and the cheaper "Cheap". Only the cheaper representative should appear.
    await seedOffer(db, { key: 'dup-expensive', title: 'Dup Expensive', price: 18000, matchKey: 'DUP', firstSeenAt: at, capturedAt: at });
    await seedOffer(db, { key: 'dup-cheap', title: 'Dup Cheap', price: 12000, matchKey: 'DUP', firstSeenAt: at, capturedAt: at });

    // A few distinct NULL-match_key offers so a market baseline can form.
    for (let i = 0; i < 8; i += 1) {
      await seedOffer(db, { key: `null-${i}`, title: `Null ${i}`, price: 20000 + i, matchKey: null, firstSeenAt: at, capturedAt: at });
    }

    const result = await buildDigest(db, makeConfig(), now);
    expect(result).not.toBeNull();
    const { html } = result!;

    // The cheaper representative is shown; the pricier duplicate is not.
    expect(html).toContain('Dup Cheap');
    expect(html).not.toContain('Dup Expensive');
  });
});
