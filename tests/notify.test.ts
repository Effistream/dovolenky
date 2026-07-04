import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, ensureSchema, type Db } from '../src/core/db/index.js';
import { notificationsLog } from '../src/core/db/schema.js';
import type { DiscountResult } from '../src/core/discount.js';
import type { Profile, NotifCfg } from '../src/core/config.js';
import type { NormalizedOffer } from '../src/core/types.js';
import {
  evaluateOffer,
  filterAgainstLog,
  recordSent,
  capMessages,
  type Candidate,
} from '../src/core/notify.js';

function makeOffer(overrides: Partial<NormalizedOffer> = {}): NormalizedOffer {
  return {
    source: 'invia',
    sourceOfferKey: 'hotel-x-2026-07-15',
    title: 'Hotel X',
    country: 'Řecko',
    locality: 'Kréta',
    stars: 4,
    board: 'AI',
    transport: 'flight',
    departureAirport: 'PRG',
    departureDate: '2026-07-15',
    nights: 7,
    pricePerPerson: 16781,
    priceTotal: 33562,
    claimedOriginalPrice: 20000,
    claimedDiscountPct: 16.1,
    omnibusLowestPrice: 15000,
    tourOperator: 'Invia',
    url: 'https://example.com/offer',
    ...overrides,
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    enabled: true,
    countries: [],
    transport: undefined,
    board: [],
    departureMonths: [],
    departureWithinDays: null,
    maxPricePerPerson: null,
    minRealDiscountPct: 15,
    notifyNewOffers: false,
    ...overrides,
  };
}

function makeDiscount(overrides: Partial<DiscountResult> = {}): DiscountResult {
  return {
    realPct: null,
    reference: null,
    baseline: null,
    fake: false,
    ...overrides,
  };
}

const CFG: NotifCfg = {
  priceDropPct: 10,
  renotifyDropPct: 5,
  renotifyAfterDays: 7,
  maxMessagesPerRun: 20,
  digestHour: 8,
};

describe('evaluateOffer', () => {
  it('hot_deal: emitted when realPct >= profile.minRealDiscountPct for a matched profile', () => {
    const result = evaluateOffer({
      offerId: 1,
      offer: makeOffer(),
      isNew: false,
      previousPrice: null,
      discount: makeDiscount({ realPct: 20 }),
      matches: [{ name: 'summer-sea', profile: makeProfile({ minRealDiscountPct: 15 }) }],
      cfg: CFG,
    });

    expect(result).toEqual([{ type: 'hot_deal', profile: 'summer-sea' }]);
  });

  it('hot_deal: not emitted when realPct is null', () => {
    const result = evaluateOffer({
      offerId: 1,
      offer: makeOffer(),
      isNew: false,
      previousPrice: null,
      discount: makeDiscount({ realPct: null }),
      matches: [{ name: 'summer-sea', profile: makeProfile({ minRealDiscountPct: 15 }) }],
      cfg: CFG,
    });

    expect(result.find((r) => r.type === 'hot_deal')).toBeUndefined();
  });

  it('hot_deal: not emitted when realPct is below every matched profile threshold', () => {
    const result = evaluateOffer({
      offerId: 1,
      offer: makeOffer(),
      isNew: false,
      previousPrice: null,
      discount: makeDiscount({ realPct: 10 }),
      matches: [{ name: 'summer-sea', profile: makeProfile({ minRealDiscountPct: 15 }) }],
      cfg: CFG,
    });

    expect(result.find((r) => r.type === 'hot_deal')).toBeUndefined();
  });

  it('hot_deal: when several profiles pass, picks the most demanding (highest minRealDiscountPct) profile', () => {
    const result = evaluateOffer({
      offerId: 1,
      offer: makeOffer(),
      isNew: false,
      previousPrice: null,
      discount: makeDiscount({ realPct: 30 }),
      matches: [
        { name: 'summer-sea', profile: makeProfile({ minRealDiscountPct: 15 }) },
        { name: 'last-minute', profile: makeProfile({ minRealDiscountPct: 25 }) },
      ],
      cfg: CFG,
    });

    const hotDeals = result.filter((r) => r.type === 'hot_deal');
    expect(hotDeals).toEqual([{ type: 'hot_deal', profile: 'last-minute' }]);
  });

  it('price_drop: emitted when the drop from previousPrice meets cfg.priceDropPct', () => {
    // previousPrice 10000 -> current (offer default) must reflect >=10% drop
    const offer = makeOffer({ pricePerPerson: 9000 });
    const result = evaluateOffer({
      offerId: 1,
      offer,
      isNew: false,
      previousPrice: 10000,
      discount: makeDiscount(),
      matches: [{ name: 'summer-sea', profile: makeProfile() }],
      cfg: CFG,
    });

    expect(result).toEqual([{ type: 'price_drop', profile: 'summer-sea' }]);
  });

  it('price_drop: not emitted when previousPrice is null', () => {
    const offer = makeOffer({ pricePerPerson: 9000 });
    const result = evaluateOffer({
      offerId: 1,
      offer,
      isNew: false,
      previousPrice: null,
      discount: makeDiscount(),
      matches: [{ name: 'summer-sea', profile: makeProfile() }],
      cfg: CFG,
    });

    expect(result.find((r) => r.type === 'price_drop')).toBeUndefined();
  });

  it('price_drop: not emitted when the drop is below cfg.priceDropPct', () => {
    const offer = makeOffer({ pricePerPerson: 9500 }); // 5% drop, threshold 10%
    const result = evaluateOffer({
      offerId: 1,
      offer,
      isNew: false,
      previousPrice: 10000,
      discount: makeDiscount(),
      matches: [{ name: 'summer-sea', profile: makeProfile() }],
      cfg: CFG,
    });

    expect(result.find((r) => r.type === 'price_drop')).toBeUndefined();
  });

  it('new_offer: emitted only when isNew && profile.notifyNewOffers, for a matched profile', () => {
    const result = evaluateOffer({
      offerId: 1,
      offer: makeOffer(),
      isNew: true,
      previousPrice: null,
      discount: makeDiscount(),
      matches: [{ name: 'summer-sea', profile: makeProfile({ notifyNewOffers: true }) }],
      cfg: CFG,
    });

    expect(result).toEqual([{ type: 'new_offer', profile: 'summer-sea' }]);
  });

  it('new_offer: not emitted when isNew is false', () => {
    const result = evaluateOffer({
      offerId: 1,
      offer: makeOffer(),
      isNew: false,
      previousPrice: null,
      discount: makeDiscount(),
      matches: [{ name: 'summer-sea', profile: makeProfile({ notifyNewOffers: true }) }],
      cfg: CFG,
    });

    expect(result.find((r) => r.type === 'new_offer')).toBeUndefined();
  });

  it('new_offer: not emitted when the matched profile has notifyNewOffers disabled', () => {
    const result = evaluateOffer({
      offerId: 1,
      offer: makeOffer(),
      isNew: true,
      previousPrice: null,
      discount: makeDiscount(),
      matches: [{ name: 'summer-sea', profile: makeProfile({ notifyNewOffers: false }) }],
      cfg: CFG,
    });

    expect(result.find((r) => r.type === 'new_offer')).toBeUndefined();
  });

  it('emits at most one entry per type, but can emit multiple types for the same offer', () => {
    const offer = makeOffer({ pricePerPerson: 9000 });
    const result = evaluateOffer({
      offerId: 1,
      offer,
      isNew: true,
      previousPrice: 10000,
      discount: makeDiscount({ realPct: 20 }),
      matches: [
        { name: 'summer-sea', profile: makeProfile({ minRealDiscountPct: 15, notifyNewOffers: true }) },
        { name: 'last-minute', profile: makeProfile({ minRealDiscountPct: 10, notifyNewOffers: true }) },
      ],
      cfg: CFG,
    });

    expect(result).toHaveLength(3);
    const types = result.map((r) => r.type).sort();
    expect(types).toEqual(['hot_deal', 'new_offer', 'price_drop']);
    // hot_deal picks the most demanding profile whose threshold (15) is still satisfied by realPct 20
    expect(result.find((r) => r.type === 'hot_deal')?.profile).toBe('summer-sea');
  });

  it('returns an empty array when no matched profiles and no conditions apply', () => {
    const result = evaluateOffer({
      offerId: 1,
      offer: makeOffer(),
      isNew: false,
      previousPrice: null,
      discount: makeDiscount(),
      matches: [],
      cfg: CFG,
    });

    expect(result).toEqual([]);
  });
});

describe('filterAgainstLog', () => {
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    await ensureSchema(db);
  });

  function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
    return {
      offerId: 1,
      offer: makeOffer(),
      discount: makeDiscount({ realPct: 20 }),
      type: 'hot_deal',
      profile: 'summer-sea',
      ...overrides,
    };
  }

  it('hot_deal: allows first-ever send (no prior log row)', async () => {
    const candidates = [makeCandidate({ type: 'hot_deal' })];
    const result = await filterAgainstLog(db, candidates, CFG, new Date('2026-07-04T12:00:00Z'));
    expect(result).toHaveLength(1);
  });

  it('hot_deal: blocks re-send when price has not dropped enough and renotifyAfterDays has not elapsed', async () => {
    const sentAt = new Date('2026-07-01T12:00:00Z'); // 3 days before "now"
    await db.insert(notificationsLog).values({
      offerId: 1,
      type: 'hot_deal',
      sentAt: sentAt.toISOString(),
      priceAtSend: 10000,
    });

    // current price 9700 -> drop of 3%, below renotifyDropPct (5%)
    const candidates = [
      makeCandidate({ type: 'hot_deal', offer: makeOffer({ pricePerPerson: 9700 }) }),
    ];
    const result = await filterAgainstLog(db, candidates, CFG, new Date('2026-07-04T12:00:00Z'));
    expect(result).toHaveLength(0);
  });

  it('hot_deal: allows re-send when price dropped by >= renotifyDropPct since priceAtSend', async () => {
    const sentAt = new Date('2026-07-01T12:00:00Z'); // 3 days before "now" (< renotifyAfterDays)
    await db.insert(notificationsLog).values({
      offerId: 1,
      type: 'hot_deal',
      sentAt: sentAt.toISOString(),
      priceAtSend: 10000,
    });

    // current price 9500 -> drop of 5%, meets renotifyDropPct (5%)
    const candidates = [
      makeCandidate({ type: 'hot_deal', offer: makeOffer({ pricePerPerson: 9500 }) }),
    ];
    const result = await filterAgainstLog(db, candidates, CFG, new Date('2026-07-04T12:00:00Z'));
    expect(result).toHaveLength(1);
  });

  it('hot_deal: allows re-send when renotifyAfterDays has elapsed even without a price drop', async () => {
    const sentAt = new Date('2026-06-20T12:00:00Z'); // way more than 7 days before "now"
    await db.insert(notificationsLog).values({
      offerId: 1,
      type: 'hot_deal',
      sentAt: sentAt.toISOString(),
      priceAtSend: 10000,
    });

    // same price as priceAtSend
    const candidates = [
      makeCandidate({ type: 'hot_deal', offer: makeOffer({ pricePerPerson: 10000 }) }),
    ];
    const result = await filterAgainstLog(db, candidates, CFG, new Date('2026-07-04T12:00:00Z'));
    expect(result).toHaveLength(1);
  });

  it('price_drop: same dedup rule as hot_deal applies independently per type', async () => {
    const sentAt = new Date('2026-07-03T12:00:00Z'); // 1 day before "now"
    await db.insert(notificationsLog).values({
      offerId: 1,
      type: 'price_drop',
      sentAt: sentAt.toISOString(),
      priceAtSend: 10000,
    });

    const candidates = [
      makeCandidate({ type: 'price_drop', offer: makeOffer({ pricePerPerson: 9800 }) }), // 2% drop, no elapsed days
    ];
    const result = await filterAgainstLog(db, candidates, CFG, new Date('2026-07-04T12:00:00Z'));
    expect(result).toHaveLength(0);
  });

  it('new_offer: never re-sent once any new_offer row exists for the offer, regardless of price/time', async () => {
    await db.insert(notificationsLog).values({
      offerId: 1,
      type: 'new_offer',
      sentAt: new Date('2020-01-01T00:00:00Z').toISOString(), // ancient, long past renotifyAfterDays
      priceAtSend: 999999, // huge drop would otherwise qualify
    });

    const candidates = [
      makeCandidate({ type: 'new_offer', offer: makeOffer({ pricePerPerson: 1 }) }),
    ];
    const result = await filterAgainstLog(db, candidates, CFG, new Date('2026-07-04T12:00:00Z'));
    expect(result).toHaveLength(0);
  });

  it('new_offer: allowed when no prior new_offer row exists for the offer', async () => {
    const candidates = [makeCandidate({ type: 'new_offer' })];
    const result = await filterAgainstLog(db, candidates, CFG, new Date('2026-07-04T12:00:00Z'));
    expect(result).toHaveLength(1);
  });

  it('uses the latest log row per offerId+type when multiple exist', async () => {
    // Older row would fail the price-drop-or-elapsed-days check; newest row passes.
    await db.insert(notificationsLog).values({
      offerId: 1,
      type: 'hot_deal',
      sentAt: new Date('2026-06-01T12:00:00Z').toISOString(),
      priceAtSend: 20000,
    });
    await db.insert(notificationsLog).values({
      offerId: 1,
      type: 'hot_deal',
      sentAt: new Date('2026-07-04T00:00:00Z').toISOString(), // recent: 12h before "now"
      priceAtSend: 10000,
    });

    // current price 9900: 1% drop from latest (10000), not enough, and not enough days elapsed since latest
    const candidates = [
      makeCandidate({ type: 'hot_deal', offer: makeOffer({ pricePerPerson: 9900 }) }),
    ];
    const result = await filterAgainstLog(db, candidates, CFG, new Date('2026-07-04T12:00:00Z'));
    expect(result).toHaveLength(0);
  });

  it('different offerIds are tracked independently', async () => {
    await db.insert(notificationsLog).values({
      offerId: 1,
      type: 'new_offer',
      sentAt: new Date('2026-07-04T00:00:00Z').toISOString(),
      priceAtSend: 10000,
    });

    const candidates = [makeCandidate({ offerId: 2, type: 'new_offer' })];
    const result = await filterAgainstLog(db, candidates, CFG, new Date('2026-07-04T12:00:00Z'));
    expect(result).toHaveLength(1);
  });
});

describe('recordSent', () => {
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    await ensureSchema(db);
  });

  it('inserts a notifications_log row with offerId, type, sentAt (ISO), and priceAtSend', async () => {
    const candidate: Candidate = {
      offerId: 42,
      offer: makeOffer({ pricePerPerson: 12345 }),
      discount: makeDiscount({ realPct: 20 }),
      type: 'hot_deal',
      profile: 'summer-sea',
    };
    const now = new Date('2026-07-04T12:00:00Z');

    await recordSent(db, candidate, now);

    const rows = await db.select().from(notificationsLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      offerId: 42,
      type: 'hot_deal',
      sentAt: now.toISOString(),
      priceAtSend: 12345,
    });
  });
});

describe('capMessages', () => {
  function makeCandidateWithRealPct(realPct: number | null, offerId: number): Candidate {
    return {
      offerId,
      offer: makeOffer(),
      discount: makeDiscount({ realPct }),
      type: 'hot_deal',
      profile: 'summer-sea',
    };
  }

  it('25 candidates, max 20 -> send 20, overflow 5', () => {
    const candidates = Array.from({ length: 25 }, (_, i) => makeCandidateWithRealPct(i, i));
    const { send, overflow } = capMessages(candidates, 20);
    expect(send).toHaveLength(20);
    expect(overflow).toBe(5);
  });

  it('sorts by discount.realPct descending, with null realPct last', () => {
    const candidates = [
      makeCandidateWithRealPct(10, 1),
      makeCandidateWithRealPct(null, 2),
      makeCandidateWithRealPct(30, 3),
      makeCandidateWithRealPct(20, 4),
    ];
    const { send, overflow } = capMessages(candidates, 10);
    expect(overflow).toBe(0);
    expect(send.map((c) => c.offerId)).toEqual([3, 4, 1, 2]);
  });

  it('when under the cap, sends all and overflow is 0', () => {
    const candidates = [makeCandidateWithRealPct(10, 1), makeCandidateWithRealPct(20, 2)];
    const { send, overflow } = capMessages(candidates, 20);
    expect(send).toHaveLength(2);
    expect(overflow).toBe(0);
  });
});
