import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { openDb, ensureSchema, type Db } from '../src/core/db/index.js';
import { offers, priceSnapshots, notificationsLog, sourceRuns } from '../src/core/db/schema.js';
import type { AppConfig, Profile } from '../src/core/config.js';
import type { NormalizedOffer, SourceAdapter, SourceContext } from '../src/core/types.js';
import { HttpClient, SourceBlockedError } from '../src/core/http.js';
import { runScan } from '../src/core/run.js';
import { ingestOffer } from '../src/core/ingest.js';
import { computeHotelKey } from '../src/core/normalize.js';
import { setExcludedCountries } from '../src/core/db/exclusions.js';

// ---- Fixtures ----------------------------------------------------------

function makeOffer(overrides: Partial<NormalizedOffer> = {}): NormalizedOffer {
  return {
    source: 'happy',
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
    url: 'https://example.com/hot',
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
    databaseAuthToken: null,
    ...overrides,
  };
}

// A fake HttpClient stand-in — adapters in these tests never touch it.
function makeHttp(): HttpClient {
  return new HttpClient({
    minGapMs: 0,
    fetchImpl: (async () => {
      throw new Error('no HTTP in tests');
    }) as unknown as typeof fetch,
    sleepImpl: async () => {},
  });
}

// Collecting telegram mock.
class TelegramMock {
  messages: string[] = [];
  async send(html: string): Promise<void> {
    this.messages.push(html);
  }
}

// ---- Fake adapters -----------------------------------------------------

function happyAdapter(returned: NormalizedOffer[]): SourceAdapter {
  return {
    name: 'happy',
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async fetchOffers(_ctx: SourceContext): Promise<NormalizedOffer[]> {
      return returned;
    },
  };
}

// A named adapter yielding a fixed offer set (for cross-source dedup scenarios
// where the source/adapter name is what distinguishes two copies of the same
// physical tour).
function namedAdapter(name: string, returned: NormalizedOffer[]): SourceAdapter {
  return {
    name,
    async fetchOffers(): Promise<NormalizedOffer[]> {
      return returned;
    },
  };
}

function throwingAdapter(): SourceAdapter {
  return {
    name: 'broken',
    async fetchOffers(): Promise<NormalizedOffer[]> {
      throw new Error('parser exploded');
    },
  };
}

function blockedAdapter(): SourceAdapter {
  return {
    name: 'blocked',
    async fetchOffers(): Promise<NormalizedOffer[]> {
      throw new SourceBlockedError(403, 'blocked');
    },
  };
}

// ---- DB seeding helpers ------------------------------------------------

/**
 * Seed `n` active offers in the same market bucket as the hot offer
 * (Řecko × month 8 × nights band 6-8 × AI × 4★) each priced `price`, so the
 * market median is high and the hot offer at 12000 shows a big real discount.
 */
async function seedMarketBucket(db: Db, n: number, price: number, at: string, country = 'Řecko'): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const [row] = await db
      .insert(offers)
      .values({
        source: 'seed',
        sourceOfferKey: `seed-${i}`,
        title: `Seed Hotel ${i}`,
        country,
        locality: 'Kréta',
        stars: 4,
        board: 'AI',
        transport: 'flight',
        departureAirport: 'PRG',
        departureDate: '2026-08-20',
        nights: 7,
        tourOperator: 'Seed',
        url: `https://example.com/seed-${i}`,
        firstSeenAt: at,
        lastSeenAt: at,
        active: true,
        misses: 0,
      })
      .returning({ id: offers.id });
    await db.insert(priceSnapshots).values({
      offerId: row!.id,
      capturedAt: at,
      pricePerPerson: price,
      priceTotal: price * 2,
      claimedOriginalPrice: null,
      claimedDiscountPct: null,
      omnibusLowestPrice: null,
    });
  }
}

/**
 * Seed `n` active OTHER terms of the SAME hotel as the hot offer (same title →
 * same hotel_key, Řecko, AI, nights within ±2, date within ±30d) at `price`, so
 * the discount ladder's "hotel" rung (≥4 terms) resolves for the subject.
 */
async function seedHotelTerms(db: Db, n: number, price: number, at: string): Promise<void> {
  const hotelKey = computeHotelKey(makeOffer());
  for (let i = 0; i < n; i += 1) {
    const [row] = await db
      .insert(offers)
      .values({
        source: 'seed',
        sourceOfferKey: `hotel-term-${i}`,
        title: 'Hotel Hot Deal', // same title → same hotel_key as the subject
        country: 'Řecko',
        locality: 'Kréta',
        stars: 4,
        board: 'AI',
        transport: 'flight',
        departureAirport: 'PRG',
        // vary nights within ±2 and dates within ±30d of the subject (7 nights, 2026-08-15)
        departureDate: `2026-08-${String(10 + i).padStart(2, '0')}`,
        nights: 7,
        tourOperator: 'Seed',
        url: `https://example.com/hotel-term-${i}`,
        firstSeenAt: at,
        lastSeenAt: at,
        active: true,
        misses: 0,
        matchKey: null,
        hotelKey,
      })
      .returning({ id: offers.id });
    await db.insert(priceSnapshots).values({
      offerId: row!.id,
      capturedAt: at,
      pricePerPerson: price,
      priceTotal: price * 2,
      claimedOriginalPrice: null,
      claimedDiscountPct: null,
      omnibusLowestPrice: null,
    });
  }
}

async function seedSourceRun(db: Db, source: string, status: string, startedAt: string): Promise<void> {
  await db.insert(sourceRuns).values({
    source,
    startedAt,
    finishedAt: startedAt,
    offersFound: 0,
    snapshotsWritten: 0,
    errorCount: 1,
    status,
    errorSample: 'x',
  });
}

// ------------------------------------------------------------------------

describe('runScan', () => {
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    await ensureSchema(db);
  });

  it('scenario 1: a throwing adapter is isolated — others continue, source_runs written', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const tg = new TelegramMock();

    const summary = await runScan({
      db,
      cfg: makeConfig(),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [throwingAdapter(), happyAdapter([makeOffer()])],
      now,
    });

    const broken = summary.perSource.find((s) => s.source === 'broken');
    const happy = summary.perSource.find((s) => s.source === 'happy');
    expect(broken?.status).toBe('failed');
    expect(broken?.error).toContain('parser exploded');
    expect(happy?.status).toBe('ok');
    expect(happy?.offersFound).toBe(1);

    // Both source_runs rows persisted.
    const runs = await db.select().from(sourceRuns);
    const brokenRun = runs.find((r) => r.source === 'broken');
    const happyRun = runs.find((r) => r.source === 'happy');
    expect(brokenRun?.status).toBe('failed');
    expect(brokenRun?.errorSample).toContain('parser exploded');
    expect(happyRun?.status).toBe('ok');

    // The happy offer was actually ingested.
    const offerRows = await db.select().from(offers).where(eq(offers.source, 'happy'));
    expect(offerRows.length).toBe(1);
  });

  it('scenario 1b: a blocked (403) adapter is recorded failed, others continue', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const tg = new TelegramMock();

    const summary = await runScan({
      db,
      cfg: makeConfig(),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [blockedAdapter(), happyAdapter([makeOffer()])],
      now,
    });

    const blocked = summary.perSource.find((s) => s.source === 'blocked');
    expect(blocked?.status).toBe('failed');
    expect(summary.perSource.find((s) => s.source === 'happy')?.status).toBe('ok');
  });

  it('scenario 2: full pipeline sends a hot_deal through telegram + logs notification', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    await seedMarketBucket(db, 8, 25000, '2026-07-04T09:00:00.000Z');
    const tg = new TelegramMock();

    const summary = await runScan({
      db,
      cfg: makeConfig(),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [happyAdapter([makeOffer()])],
      now,
    });

    expect(summary.notificationsSent).toBe(1);
    const hot = tg.messages.find((m) => m.includes('🔥'));
    expect(hot).toBeDefined();
    expect(hot).toContain('Hotel Hot Deal');

    const logs = await db.select().from(notificationsLog).where(eq(notificationsLog.type, 'hot_deal'));
    expect(logs.length).toBe(1);
    expect(logs[0]?.priceAtSend).toBe(12000);
  });

  it('scenario 2c: an excluded country is MUTED (no notification) but STILL ingested (snapshot written)', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    // Global negative filter (Task 43) set BEFORE the scan: Egypt is muted.
    await setExcludedCountries(db, ['Egypt']);

    // Same setup as scenario 2, only in Egypt: an Egypt market bucket makes the
    // subject Egypt offer a genuine hot_deal that WOULD notify if it weren't excluded.
    await seedMarketBucket(db, 8, 25000, '2026-07-04T09:00:00.000Z', 'Egypt');
    const egyptOffer = makeOffer({ country: 'Egypt', sourceOfferKey: 'eg-1' });
    const tg = new TelegramMock();

    const summary = await runScan({
      db,
      cfg: makeConfig(),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [happyAdapter([egyptOffer])],
      now,
    });

    // Muted: no candidate generated for the excluded country → nothing sent.
    expect(summary.notificationsSent).toBe(0);
    expect(tg.messages.some((m) => m.includes('Egypt'))).toBe(false);
    expect(tg.messages.filter((m) => m.includes('🔥'))).toHaveLength(0);
    const hotLogs = await db.select().from(notificationsLog).where(eq(notificationsLog.type, 'hot_deal'));
    expect(hotLogs.length).toBe(0);

    // Ingest PRESERVED: the excluded offer was still stored AND got a price snapshot
    // (the guard suppresses only candidate generation, never the snapshot write above it).
    const [egyptRow] = await db
      .select()
      .from(offers)
      .where(and(eq(offers.source, 'happy'), eq(offers.sourceOfferKey, 'eg-1')));
    expect(egyptRow).toBeDefined();
    const egyptSnaps = await db
      .select()
      .from(priceSnapshots)
      .where(eq(priceSnapshots.offerId, egyptRow!.id));
    expect(egyptSnaps.length).toBeGreaterThanOrEqual(1);
  });

  it('scenario 2b: price_drop send includes the "↓ z" previous-price line', async () => {
    const firstRun = new Date('2026-07-01T10:00:00.000Z');
    const secondRun = new Date('2026-07-04T10:00:00.000Z');
    const tg = new TelegramMock();

    // First scan establishes a snapshot at 12000 (no notifications config needed —
    // no profiles matched yet is fine, we only need the price history).
    await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [happyAdapter([makeOffer({ pricePerPerson: 12000 })])],
      now: firstRun,
    });

    // Second scan: price drops to 10000 (>=10% drop from 12000, meets priceDropPct).
    const summary = await runScan({
      db,
      cfg: makeConfig(),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [happyAdapter([makeOffer({ pricePerPerson: 10000 })])],
      now: secondRun,
    });

    expect(summary.notificationsSent).toBeGreaterThanOrEqual(1);
    const drop = tg.messages.find((m) => m.includes('📉'));
    expect(drop).toBeDefined();
    expect(drop).toContain('↓ z');
    expect(drop).toContain('12 000 Kč');

    const logs = await db.select().from(notificationsLog).where(eq(notificationsLog.type, 'price_drop'));
    expect(logs.length).toBe(1);
    expect(logs[0]?.priceAtSend).toBe(10000);
  });

  it('scenario 3: dryRun sends nothing, logs nothing, but summary counts would-sends', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    await seedMarketBucket(db, 8, 25000, '2026-07-04T09:00:00.000Z');
    const tg = new TelegramMock();

    const summary = await runScan({
      db,
      cfg: makeConfig(),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [happyAdapter([makeOffer()])],
      now,
      dryRun: true,
    });

    expect(summary.notificationsSent).toBe(1); // would-send count
    expect(tg.messages.length).toBe(0); // nothing actually sent

    const logs = await db.select().from(notificationsLog);
    expect(logs.length).toBe(0); // nothing logged
  });

  it('scenario 4: health alert fires exactly on the 3rd consecutive failure, not the 4th', async () => {
    const tg = new TelegramMock();

    // Case A: two prior failures already recorded → this run is the 3rd → alert.
    await seedSourceRun(db, 'broken', 'failed', '2026-07-04T06:00:00.000Z');
    await seedSourceRun(db, 'broken', 'failed', '2026-07-04T08:00:00.000Z');

    const summaryA = await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [throwingAdapter()],
      now: new Date('2026-07-04T10:00:00.000Z'),
    });
    expect(summaryA.perSource[0]?.status).toBe('failed');

    const alerts = tg.messages.filter((m) => m.includes('🛠'));
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain('broken');

    // Case B: three prior failures already recorded → this run is the 4th → NO new alert.
    const db2 = openDb(':memory:');
    await ensureSchema(db2);
    const tg2 = new TelegramMock();
    await seedSourceRun(db2, 'broken', 'failed', '2026-07-04T04:00:00.000Z');
    await seedSourceRun(db2, 'broken', 'failed', '2026-07-04T06:00:00.000Z');
    await seedSourceRun(db2, 'broken', 'failed', '2026-07-04T08:00:00.000Z');

    await runScan({
      db: db2,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: tg2 as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [throwingAdapter()],
      now: new Date('2026-07-04T10:00:00.000Z'),
    });

    const alerts2 = tg2.messages.filter((m) => m.includes('🛠'));
    expect(alerts2.length).toBe(0);
  });

  it('scenario 5: digest sent once at 08:15 when none today, not sent a second time same day', async () => {
    // now 08:15 Prague on 2026-07-04. Seed an active offer so digest has content.
    const now = new Date('2026-07-04T06:15:00.000Z'); // 08:15 Europe/Prague (CEST = UTC+2)
    await seedMarketBucket(db, 1, 20000, '2026-07-03T09:00:00.000Z');
    const tg = new TelegramMock();

    const summary1 = await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [],
      now,
    });

    expect(summary1.digestSent).toBe(true);
    const digestMsgs = tg.messages.filter((m) => m.includes('přehled'));
    expect(digestMsgs.length).toBe(1);

    const digestLogs = await db.select().from(notificationsLog).where(eq(notificationsLog.type, 'digest'));
    expect(digestLogs.length).toBe(1);

    // Second run same day, later hour → no second digest.
    const later = new Date('2026-07-04T08:15:00.000Z'); // 10:15 Prague, same Prague day
    const summary2 = await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [],
      now: later,
    });

    expect(summary2.digestSent).toBe(false);
    const digestLogs2 = await db.select().from(notificationsLog).where(eq(notificationsLog.type, 'digest'));
    expect(digestLogs2.length).toBe(1); // still just one
  });

  it('scenario 5b: digest not sent before digestHour', async () => {
    const now = new Date('2026-07-04T04:30:00.000Z'); // 06:30 Prague, before hour 8
    await seedMarketBucket(db, 1, 20000, '2026-07-03T09:00:00.000Z');
    const tg = new TelegramMock();

    const summary = await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [],
      now,
    });

    expect(summary.digestSent).toBe(false);
  });

  it('scenario 6: markMissedOffers runs per source that returns a (non-empty) offer set', async () => {
    const now0 = new Date('2026-07-04T08:00:00.000Z');
    // A different offer under the same source, present on every run so the source is never
    // zero-offer (which would skip markMissedOffers entirely — see scenario 6b). The original
    // offer disappears from that non-empty set and so is genuinely missed.
    const otherOffer = makeOffer({ sourceOfferKey: 'other-still-here', url: 'https://example.com/other' });

    // First scan: both offers present.
    await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [happyAdapter([makeOffer(), otherOffer])],
      now: now0,
    });
    // Second scan: only the other offer → original missed #1.
    await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [happyAdapter([otherOffer])],
      now: new Date('2026-07-04T10:00:00.000Z'),
    });
    // Third scan: still only the other offer → original missed #2 → inactive.
    await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [happyAdapter([otherOffer])],
      now: new Date('2026-07-04T12:00:00.000Z'),
    });

    const [row] = await db
      .select()
      .from(offers)
      .where(and(eq(offers.source, 'happy'), eq(offers.sourceOfferKey, 'hotel-hot-2026-08-15')));
    expect(row?.misses).toBe(2);
    expect(row?.active).toBe(false);

    // The still-present offer must stay active with zero misses throughout.
    const [otherRow] = await db
      .select()
      .from(offers)
      .where(and(eq(offers.source, 'happy'), eq(offers.sourceOfferKey, 'other-still-here')));
    expect(otherRow?.misses).toBe(0);
    expect(otherRow?.active).toBe(true);
  });

  it('scenario 6b: a zero-offer source is "partial" and does NOT mark its offers missed (C1/C2)', async () => {
    // First scan: offer present and ingested.
    await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [happyAdapter([makeOffer()])],
      now: new Date('2026-07-04T08:00:00.000Z'),
    });

    // Second & third scans: adapter returns [] (e.g. total listing failure swallowed to [], or
    // zajezdy's intentional out-of-window skip). markMissedOffers MUST be skipped both times, so
    // the offer stays active — otherwise a couple of empty runs would flip the whole inventory
    // inactive and the health alert could never fire.
    for (const t of ['2026-07-04T10:00:00.000Z', '2026-07-04T12:00:00.000Z']) {
      const summary = await runScan({
        db,
        cfg: makeConfig({ profiles: {} }),
        http: makeHttp(),
        telegram: null,
        adapters: [happyAdapter([])],
        now: new Date(t),
      });
      const happy = summary.perSource.find((s) => s.source === 'happy');
      expect(happy?.status).toBe('partial');
      expect(happy?.offersFound).toBe(0);
    }

    const [row] = await db
      .select()
      .from(offers)
      .where(and(eq(offers.source, 'happy'), eq(offers.sourceOfferKey, 'hotel-hot-2026-08-15')));
    expect(row?.misses).toBe(0);
    expect(row?.active).toBe(true);
  });

  it('scenario 7: null telegram behaves like dry-run for sends but still counts', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    await seedMarketBucket(db, 8, 25000, '2026-07-04T09:00:00.000Z');

    const summary = await runScan({
      db,
      cfg: makeConfig(),
      http: makeHttp(),
      telegram: null,
      adapters: [happyAdapter([makeOffer()])],
      now,
    });

    expect(summary.notificationsSent).toBe(1);
    const logs = await db.select().from(notificationsLog);
    expect(logs.length).toBe(0); // nothing logged when nothing actually sent
  });

  it('scenario 8: overflow line appended when candidates exceed maxMessagesPerRun', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    await seedMarketBucket(db, 8, 25000, '2026-07-04T09:00:00.000Z');
    const tg = new TelegramMock();

    // Three distinct hot offers (distinct hotels → distinct match_keys, so cross-source
    // dedup does NOT collapse them), cap of 2 → one overflow.
    const o1 = makeOffer({ title: 'Hotel One', sourceOfferKey: 'k1', url: 'https://e.com/1', pricePerPerson: 10000 });
    const o2 = makeOffer({ title: 'Hotel Two', sourceOfferKey: 'k2', url: 'https://e.com/2', pricePerPerson: 11000 });
    const o3 = makeOffer({ title: 'Hotel Three', sourceOfferKey: 'k3', url: 'https://e.com/3', pricePerPerson: 12000 });

    const summary = await runScan({
      db,
      cfg: makeConfig({
        notifications: {
          priceDropPct: 10,
          renotifyDropPct: 5,
          renotifyAfterDays: 7,
          maxMessagesPerRun: 2,
          digestHour: 8,
        },
      }),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [happyAdapter([o1, o2, o3])],
      now,
    });

    expect(summary.notificationsSent).toBe(2);
    const overflowMsg = tg.messages.find((m) => m.includes('dalších'));
    expect(overflowMsg).toBeDefined();
    expect(overflowMsg).toContain('1');
  });

  it('scenario 9: a thrown seed failure → status failed, and the source is NOT mass-missed (C1)', async () => {
    // Seed an offer for the source so, if markMissedOffers wrongly ran on the failed run, the
    // offer would flip toward inactive. A failing fetch must instead leave it untouched.
    await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [{ name: 'broken', async fetchOffers() { return [makeOffer({ source: 'broken' })]; } }],
      now: new Date('2026-07-04T08:00:00.000Z'),
    });

    const summary = await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [throwingAdapter()], // name 'broken', throws
      now: new Date('2026-07-04T10:00:00.000Z'),
    });

    expect(summary.perSource[0]?.status).toBe('failed');

    // The pre-existing offer must NOT have been marked missed by the failed run.
    const [row] = await db
      .select()
      .from(offers)
      .where(eq(offers.source, 'broken'));
    expect(row?.misses).toBe(0);
    expect(row?.active).toBe(true);
  });

  it('scenario 9b: an intentional empty return (e.g. zajezdy out-of-window) → partial, benign note, no misses (C2)', async () => {
    const summary = await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [happyAdapter([])],
      now: new Date('2026-07-04T10:00:00.000Z'),
    });

    expect(summary.perSource[0]?.status).toBe('partial');

    const [run] = await db.select().from(sourceRuns).where(eq(sourceRuns.source, 'happy'));
    expect(run?.status).toBe('partial');
    expect(run?.errorSample).toContain('zero offers'); // benign note, not an error
    expect(run?.offersFound).toBe(0);
  });

  it('scenario 10: dry-run keeps ingest/snapshot writes but SKIPS markMissedOffers (I1)', async () => {
    // First (real) scan ingests two offers.
    const other = makeOffer({ sourceOfferKey: 'other-key', url: 'https://example.com/other' });
    await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [happyAdapter([makeOffer(), other])],
      now: new Date('2026-07-04T08:00:00.000Z'),
    });

    const snapsBefore = await db.select().from(priceSnapshots);

    // Dry run where only `other` is returned at a NEW price. The original disappears from a
    // non-empty set, but because it's a dry run markMissedOffers must be skipped (no misses),
    // while the snapshot for `other`'s new price is still written (history is collected).
    await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [happyAdapter([makeOffer({ sourceOfferKey: 'other-key', url: 'https://example.com/other', pricePerPerson: 9000 })])],
      now: new Date('2026-07-04T10:00:00.000Z'),
      dryRun: true,
    });

    // markMissedOffers skipped: the vanished original still has 0 misses and is active.
    const [orig] = await db
      .select()
      .from(offers)
      .where(and(eq(offers.source, 'happy'), eq(offers.sourceOfferKey, 'hotel-hot-2026-08-15')));
    expect(orig?.misses).toBe(0);
    expect(orig?.active).toBe(true);

    // Ingest/snapshot writes still happened: a new snapshot at 9000 for `other`.
    const snapsAfter = await db.select().from(priceSnapshots);
    expect(snapsAfter.length).toBeGreaterThan(snapsBefore.length);
    expect(snapsAfter.some((s) => s.pricePerPerson === 9000)).toBe(true);
  });

  it('scenario 11: 24h backoff skips a source blocked <24h ago (no adapter call), runs it after 24h (I2)', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');

    // A recent block (2h ago): a failed source_run whose error_sample starts with BLOCKED:.
    await db.insert(sourceRuns).values({
      source: 'blocked',
      startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      finishedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      offersFound: 0,
      snapshotsWritten: 0,
      errorCount: 1,
      status: 'failed',
      errorSample: 'BLOCKED:Request blocked with status 403',
    });

    let called = 0;
    const spy: SourceAdapter = {
      name: 'blocked',
      async fetchOffers() {
        called += 1;
        return [makeOffer({ source: 'blocked' })];
      },
    };

    const summaryA = await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [spy],
      now,
    });

    // Skipped: adapter never called; run recorded 'partial'/backoff.
    expect(called).toBe(0);
    expect(summaryA.perSource[0]?.status).toBe('partial');
    const runs = await db.select().from(sourceRuns).where(eq(sourceRuns.source, 'blocked'));
    const backoffRun = runs.find((r) => r.errorSample === 'backoff');
    expect(backoffRun).toBeDefined();

    // Fresh DB: the same block but 25h ago → backoff has lifted, adapter runs normally.
    const db2 = openDb(':memory:');
    await ensureSchema(db2);
    await db2.insert(sourceRuns).values({
      source: 'blocked',
      startedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
      finishedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
      offersFound: 0,
      snapshotsWritten: 0,
      errorCount: 1,
      status: 'failed',
      errorSample: 'BLOCKED:Request blocked with status 403',
    });

    let called2 = 0;
    const spy2: SourceAdapter = {
      name: 'blocked',
      async fetchOffers() {
        called2 += 1;
        return [makeOffer({ source: 'blocked' })];
      },
    };

    const summaryB = await runScan({
      db: db2,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [spy2],
      now,
    });

    expect(called2).toBe(1);
    expect(summaryB.perSource[0]?.status).toBe('ok');
  });

  it('scenario 11b: a blocked seed error is recorded with a BLOCKED: error_sample so backoff can see it (I2)', async () => {
    const summary = await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [blockedAdapter()], // throws SourceBlockedError(403)
      now: new Date('2026-07-04T10:00:00.000Z'),
    });

    expect(summary.perSource[0]?.status).toBe('failed');
    const [run] = await db.select().from(sourceRuns).where(eq(sourceRuns.source, 'blocked'));
    expect(run?.status).toBe('failed');
    expect(run?.errorSample?.startsWith('BLOCKED:')).toBe(true);
  });

  it('scenario 11c: a persistent block stays held for 24h — the backoff row it just wrote does not un-hold it (I2)', async () => {
    // The block happens at T0. The backoff mechanism inserts its own benign 'partial'/backoff row
    // each skipped run; blockedBackoffUntil must SKIP those rows and keep reading the original
    // BLOCKED failure, or the source would be re-called every backoff cycle (~4h) instead of held.
    const t0 = new Date('2026-07-04T00:00:00.000Z');
    await db.insert(sourceRuns).values({
      source: 'blocked',
      startedAt: t0.toISOString(),
      finishedAt: t0.toISOString(),
      offersFound: 0,
      snapshotsWritten: 0,
      errorCount: 1,
      status: 'failed',
      errorSample: 'BLOCKED:Request blocked with status 403',
    });

    let called = 0;
    const spy: SourceAdapter = {
      name: 'blocked',
      async fetchOffers() {
        called += 1;
        return [makeOffer({ source: 'blocked' })];
      },
    };

    // Run at T0+2h → skipped, writes a backoff row.
    const s1 = await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [spy],
      now: new Date(t0.getTime() + 2 * 60 * 60 * 1000),
    });
    expect(called).toBe(0);
    expect(s1.perSource[0]?.status).toBe('partial');

    // Run again at T0+4h with the T0+2h backoff row now the most-recent row → STILL skipped.
    // (Before the fix, the most-recent-row read would see 'partial'/backoff, not the block, and
    // the adapter would be called again.)
    const s2 = await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [spy],
      now: new Date(t0.getTime() + 4 * 60 * 60 * 1000),
    });
    expect(called).toBe(0);
    expect(s2.perSource[0]?.status).toBe('partial');

    // Run at T0+25h → block has aged out, adapter finally runs.
    const s3 = await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [spy],
      now: new Date(t0.getTime() + 25 * 60 * 60 * 1000),
    });
    expect(called).toBe(1);
    expect(s3.perSource[0]?.status).toBe('ok');
  });

  it('scenario 11d: health alert fires for a persistently blocked source despite interleaved backoff rows (I2)', async () => {
    const tg = new TelegramMock();

    // Prior history in id order: two REAL BLOCKED failures, each followed by a benign backoff row.
    // Filtered to real runs this is [failed, failed]; the current run is the 3rd real failure.
    await db.insert(sourceRuns).values([
      {
        source: 'blocked',
        startedAt: '2026-07-01T00:00:00.000Z',
        finishedAt: '2026-07-01T00:00:00.000Z',
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 1,
        status: 'failed',
        errorSample: 'BLOCKED:Request blocked with status 403',
      },
      {
        source: 'blocked',
        startedAt: '2026-07-01T04:00:00.000Z',
        finishedAt: '2026-07-01T04:00:00.000Z',
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 0,
        status: 'partial',
        errorSample: 'backoff',
      },
      {
        source: 'blocked',
        startedAt: '2026-07-02T02:00:00.000Z',
        finishedAt: '2026-07-02T02:00:00.000Z',
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 1,
        status: 'failed',
        errorSample: 'BLOCKED:Request blocked with status 403',
      },
      {
        source: 'blocked',
        startedAt: '2026-07-02T06:00:00.000Z',
        finishedAt: '2026-07-02T06:00:00.000Z',
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 0,
        status: 'partial',
        errorSample: 'backoff',
      },
    ]);

    // Current run: the block has aged out (>24h since last real failure) so the adapter is called,
    // and it blocks again → 3rd real failure → alert.
    const summary = await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [blockedAdapter()],
      now: new Date('2026-07-04T10:00:00.000Z'),
    });
    expect(summary.perSource[0]?.status).toBe('failed');

    const alerts = tg.messages.filter((m) => m.includes('🛠'));
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain('blocked');

    // With a 4th real prior failure in the filtered chain, this would be the 4th failure → no alert.
    const db2 = openDb(':memory:');
    await ensureSchema(db2);
    const tg2 = new TelegramMock();
    await db2.insert(sourceRuns).values([
      {
        source: 'blocked',
        startedAt: '2026-06-30T00:00:00.000Z',
        finishedAt: '2026-06-30T00:00:00.000Z',
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 1,
        status: 'failed',
        errorSample: 'BLOCKED:Request blocked with status 403',
      },
      {
        source: 'blocked',
        startedAt: '2026-06-30T04:00:00.000Z',
        finishedAt: '2026-06-30T04:00:00.000Z',
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 0,
        status: 'partial',
        errorSample: 'backoff',
      },
      {
        source: 'blocked',
        startedAt: '2026-07-01T00:00:00.000Z',
        finishedAt: '2026-07-01T00:00:00.000Z',
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 1,
        status: 'failed',
        errorSample: 'BLOCKED:Request blocked with status 403',
      },
      {
        source: 'blocked',
        startedAt: '2026-07-01T04:00:00.000Z',
        finishedAt: '2026-07-01T04:00:00.000Z',
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 0,
        status: 'partial',
        errorSample: 'backoff',
      },
      {
        source: 'blocked',
        startedAt: '2026-07-02T02:00:00.000Z',
        finishedAt: '2026-07-02T02:00:00.000Z',
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 1,
        status: 'failed',
        errorSample: 'BLOCKED:Request blocked with status 403',
      },
      {
        source: 'blocked',
        startedAt: '2026-07-02T06:00:00.000Z',
        finishedAt: '2026-07-02T06:00:00.000Z',
        offersFound: 0,
        snapshotsWritten: 0,
        errorCount: 0,
        status: 'partial',
        errorSample: 'backoff',
      },
    ]);

    await runScan({
      db: db2,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: tg2 as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [blockedAdapter()],
      now: new Date('2026-07-04T10:00:00.000Z'),
    });

    const alerts2 = tg2.messages.filter((m) => m.includes('🛠'));
    expect(alerts2.length).toBe(0);
  });

  it('scenario 12: two sources of the same physical tour → ONE message with "Také:" and a match_key-carrying log row (spec §13)', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    // Seed a market bucket so both copies show a big real discount and become hot_deals.
    await seedMarketBucket(db, 8, 25000, '2026-07-04T09:00:00.000Z');
    const tg = new TelegramMock();

    // Same physical tour (same title/country/date/nights/board/airport → same match_key)
    // from two different sources at different prices. The cheaper (invia, 12000) is the
    // representative; the pricier (skrz, 13500) becomes an alternative.
    const physical = {
      title: 'Hotel Hot Deal',
      country: 'Řecko',
      departureDate: '2026-08-15',
      nights: 7,
      board: 'AI' as const,
      departureAirport: 'PRG',
    };
    const inviaOffer = makeOffer({
      ...physical,
      source: 'invia',
      sourceOfferKey: 'invia-key',
      url: 'https://invia.example/deal',
      pricePerPerson: 12000,
    });
    const skrzOffer = makeOffer({
      ...physical,
      source: 'skrz',
      sourceOfferKey: 'skrz-key',
      url: 'https://skrz.example/deal',
      pricePerPerson: 13500,
    });

    const summary = await runScan({
      db,
      cfg: makeConfig(),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [namedAdapter('invia', [inviaOffer]), namedAdapter('skrz', [skrzOffer])],
      now,
    });

    // Exactly one notification, mentioning the cheaper representative and the pricier alternative.
    const hotMsgs = tg.messages.filter((m) => m.includes('🔥'));
    expect(hotMsgs).toHaveLength(1);
    expect(summary.notificationsSent).toBe(1);
    const msg = hotMsgs[0]!;
    expect(msg).toContain('12 000 Kč'); // representative price
    expect(msg).toContain('Také:');
    expect(msg).toContain('Skrz'); // the pricier alternative source, capitalized
    expect(msg).toContain('13 500 Kč');

    // The log row carries a non-null match_key (so the second source can't re-notify next run).
    const logs = await db.select().from(notificationsLog).where(eq(notificationsLog.type, 'hot_deal'));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.matchKey).not.toBeNull();

    // A second identical run must NOT re-notify (blocked by the group's match_key log row).
    const tg2 = new TelegramMock();
    const summary2 = await runScan({
      db,
      cfg: makeConfig(),
      http: makeHttp(),
      telegram: tg2 as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [namedAdapter('invia', [inviaOffer]), namedAdapter('skrz', [skrzOffer])],
      now: new Date('2026-07-04T11:00:00.000Z'),
    });
    expect(summary2.notificationsSent).toBe(0);
    expect(tg2.messages.filter((m) => m.includes('🔥'))).toHaveLength(0);
  });

  it('scenario 13: priorTitles is populated from non-placeholder stored titles for that source and passed to fetchOffers', async () => {
    const t0 = new Date('2026-07-04T10:00:00.000Z');

    // Seed the DB directly (bypassing the adapter) to simulate offers already ingested in a
    // previous run: one with a real resolved name, one still on the "Hotel <id>" placeholder,
    // and one belonging to a DIFFERENT source (must not leak into this source's priorTitles map).
    await ingestOffer(
      db,
      makeOffer({ source: 'dv', sourceOfferKey: 'dv-real', title: 'Creek Hotel' }),
      t0,
    );
    await ingestOffer(
      db,
      makeOffer({ source: 'dv', sourceOfferKey: 'dv-placeholder', title: 'Hotel 999' }),
      t0,
    );
    await ingestOffer(
      db,
      makeOffer({ source: 'other', sourceOfferKey: 'dv-real', title: 'Should Not Leak' }),
      t0,
    );

    let capturedPriorTitles: Map<string, string> | undefined;
    const spy: SourceAdapter = {
      name: 'dv',
      async fetchOffers(ctx: SourceContext) {
        capturedPriorTitles = ctx.priorTitles;
        return [];
      },
    };

    await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [spy],
      now: new Date(t0.getTime() + 60 * 60 * 1000),
    });

    expect(capturedPriorTitles).toBeDefined();
    expect(capturedPriorTitles?.get('dv-real')).toBe('Creek Hotel');
    expect(capturedPriorTitles?.has('dv-placeholder')).toBe(false);
    expect(capturedPriorTitles?.size).toBe(1);
  });

  it('scenario 14: a subject with ≥4 same-hotel terms resolves reference="hotel" end-to-end (spec §15)', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    // 4 other terms of the SAME hotel at 21000/7 = 3000/night. The subject at
    // 12000/7 ≈ 1714/night is well below → a big real discount on the hotel rung.
    await seedHotelTerms(db, 4, 21000, '2026-07-04T09:00:00.000Z');
    const tg = new TelegramMock();

    // The 4 same-hotel terms qualify the "hotel" rung (≥4) but are too few for the
    // locality (≥8) or market (≥8) rungs, so the ladder can only resolve via hotel.
    const summary = await runScan({
      db,
      cfg: makeConfig(),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [happyAdapter([makeOffer()])],
      now,
    });

    expect(summary.notificationsSent).toBe(1);
    const hot = tg.messages.find((m) => m.includes('🔥'));
    expect(hot).toBeDefined();
    expect(hot).toContain('Hotel Hot Deal');

    // Direct confirmation of the reference rung: recompute the discount exactly as
    // processOffers does, over the persisted state.
    const { hotelTermPricesPN, localityBucketPricesPN, marketBucketPrices, ownSnapshotsFor } = await import(
      '../src/core/market.js'
    );
    const { computeRealDiscount } = await import('../src/core/discount.js');
    const [subjectRow] = await db
      .select()
      .from(offers)
      .where(and(eq(offers.source, 'happy'), eq(offers.sourceOfferKey, 'hotel-hot-2026-08-15')));
    const subjectOffer = makeOffer();
    const hotelPN = await hotelTermPricesPN(db, subjectRow!.id, subjectOffer);
    const localityPN = await localityBucketPricesPN(db, subjectRow!.id, subjectOffer);
    const marketPN = await marketBucketPrices(db, subjectRow!.id, subjectOffer);
    const own = await ownSnapshotsFor(db, subjectRow!.id, now);
    const d = computeRealDiscount({
      current: 12000,
      ownSnapshots: own,
      omnibus: null,
      nights: 7,
      hotelTermPricesPN: hotelPN,
      localityPricesPN: localityPN,
      marketPricesPN: marketPN,
      claimedPct: null,
      now,
    });
    expect(hotelPN).toHaveLength(4);
    expect(d.reference).toBe('hotel');
    expect(d.realPct).toBe(43); // round((3000-1714)/3000*100)
  });

  it('scenario 15: the 1-night domestic-stay artifact no longer shows a bogus discount (per-night fair)', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    // The subject is a 1-night stay at 3000 total (3000/night). Its hotel has ≥4
    // other terms whose per-night price is ~2000/night. Per-night, 3000 is a price
    // INCREASE vs the 2000 median — NOT the old bogus discount that came from
    // comparing a 3000 total against multi-night totals.
    const oneNight = makeOffer({
      title: 'Hotel One Night',
      sourceOfferKey: 'one-night',
      url: 'https://example.com/one-night',
      nights: 1,
      pricePerPerson: 3000,
      priceTotal: 6000,
    });

    // 5 same-hotel multi-night terms at 2000/night (e.g. 7 nights × 2000 = 14000),
    // within nights ±2? No — 7 is NOT within ±2 of 1. Use short stays (nights 2-3,
    // within ±2 of 1) at 2000/night so they land in the hotel rung for this subject.
    const hotelKey = computeHotelKey(oneNight);
    for (let i = 0; i < 5; i += 1) {
      const nights = 2 + (i % 2); // 2 or 3 nights (within ±2 of 1)
      const [row] = await db
        .insert(offers)
        .values({
          source: 'seed',
          sourceOfferKey: `on-term-${i}`,
          title: 'Hotel One Night',
          country: 'Řecko',
          locality: 'Kréta',
          stars: 4,
          board: 'AI',
          transport: 'flight',
          departureAirport: 'PRG',
          departureDate: `2026-08-${String(12 + i).padStart(2, '0')}`,
          nights,
          tourOperator: 'Seed',
          url: `https://example.com/on-term-${i}`,
          firstSeenAt: '2026-07-04T09:00:00.000Z',
          lastSeenAt: '2026-07-04T09:00:00.000Z',
          active: true,
          misses: 0,
          matchKey: null,
          hotelKey,
        })
        .returning({ id: offers.id });
      await db.insert(priceSnapshots).values({
        offerId: row!.id,
        capturedAt: '2026-07-04T09:00:00.000Z',
        pricePerPerson: nights * 2000, // 2000/night
        priceTotal: nights * 4000,
        claimedOriginalPrice: null,
        claimedDiscountPct: null,
        omnibusLowestPrice: null,
      });
    }

    const tg = new TelegramMock();
    const summary = await runScan({
      db,
      cfg: makeConfig(),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [happyAdapter([oneNight])],
      now,
    });

    // No hot_deal: per-night, 3000 > 2000 median → realPct negative → below the
    // 15% profile threshold. (The old total-bucket logic mis-rated it as ~-54%
    // OR a spurious discount; either way it must NOT notify now.)
    expect(summary.notificationsSent).toBe(0);
    expect(tg.messages.filter((m) => m.includes('🔥'))).toHaveLength(0);

    // Confirm the reference rung + sign directly.
    const { hotelTermPricesPN } = await import('../src/core/market.js');
    const { computeRealDiscount } = await import('../src/core/discount.js');
    const [subjectRow] = await db
      .select()
      .from(offers)
      .where(and(eq(offers.source, 'happy'), eq(offers.sourceOfferKey, 'one-night')));
    const hotelPN = await hotelTermPricesPN(db, subjectRow!.id, oneNight);
    const d = computeRealDiscount({
      current: 3000,
      ownSnapshots: [],
      omnibus: null,
      nights: 1,
      hotelTermPricesPN: hotelPN,
      localityPricesPN: [],
      marketPricesPN: [],
      claimedPct: null,
      now,
    });
    expect(hotelPN.length).toBeGreaterThanOrEqual(4);
    expect(d.reference).toBe('hotel');
    expect(d.realPct).toBe(-50); // round((2000-3000)/2000*100) → a markup, not a discount
  });

  it('scenario 16: scan-time keys use the PERSISTED (sticky-guarded) title, not a placeholder incoming title (2026-07-07 fix)', async () => {
    const t0 = new Date('2026-07-04T09:00:00.000Z');
    const now = new Date('2026-07-04T10:00:00.000Z');

    // The subject offer, already ingested once with its real, resolved title. Country/board/
    // transport/departure month/price all sit inside LETO_MORE so a hot_deal can actually fire.
    const resolved = makeOffer({
      source: 'dv',
      sourceOfferKey: 'dv-subject',
      title: 'Creek Hotel Resort',
      url: 'https://example.com/dv-subject',
    });
    await ingestOffer(db, resolved, t0);

    // 4 other terms of the SAME hotel (same resolved title → same hotel_key), so the "hotel" rung
    // (≥4) qualifies for the subject — mirrors seedHotelTerms but keyed off the resolved title.
    const hotelKey = computeHotelKey(resolved);
    for (let i = 0; i < 4; i += 1) {
      const [row] = await db
        .insert(offers)
        .values({
          source: 'seed',
          sourceOfferKey: `dv-sibling-${i}`,
          title: 'Creek Hotel Resort',
          country: 'Řecko',
          locality: 'Kréta',
          stars: 4,
          board: 'AI',
          transport: 'flight',
          departureAirport: 'PRG',
          departureDate: `2026-08-${String(10 + i).padStart(2, '0')}`,
          nights: 7,
          tourOperator: 'Seed',
          url: `https://example.com/dv-sibling-${i}`,
          firstSeenAt: t0.toISOString(),
          lastSeenAt: t0.toISOString(),
          active: true,
          misses: 0,
          matchKey: null,
          hotelKey,
        })
        .returning({ id: offers.id });
      await db.insert(priceSnapshots).values({
        offerId: row!.id,
        capturedAt: t0.toISOString(),
        pricePerPerson: 21000, // 21000/7 = 3000/night
        priceTotal: 42000,
        claimedOriginalPrice: null,
        claimedDiscountPct: null,
        omnibusLowestPrice: null,
      });
    }

    // Now the SAME dovolenkovani-style offer re-arrives with a placeholder title (its per-run
    // resolution cap was exhausted this time). ingestOffer's sticky-name guard keeps "Creek Hotel
    // Resort" persisted in the DB — but before the fix, run.ts fed the raw incoming (placeholder)
    // offer into computeHotelKey/hotelTermPricesPN, so the scan-time hotel_key would NOT match the
    // siblings' persisted hotel_key (derived from "Creek Hotel Resort") and the ladder would fall
    // through past "hotel" to "market" (or null, since there's no market bucket seeded here).
    const placeholderIncoming = makeOffer({
      source: 'dv',
      sourceOfferKey: 'dv-subject',
      title: 'Hotel 320645',
      url: 'https://example.com/dv-subject',
      pricePerPerson: 12000, // 12000/7 ≈ 1714/night, well below the 3000/night sibling median
    });

    const spy: SourceAdapter = {
      name: 'dv',
      async fetchOffers() {
        return [placeholderIncoming];
      },
    };

    const tg = new TelegramMock();

    // LETO_MORE (Řecko / flight / AI / departs Jun–Sep / ≤25000 Kč/os. / ≥15% real discount)
    // matches this offer, so a genuine realPct >= 15 produces a hot_deal candidate that
    // actually reaches the telegram mock — nothing here is recomputed by the test.
    const summary = await runScan({
      db,
      cfg: makeConfig(),
      http: makeHttp(),
      telegram: tg as unknown as import('../src/core/telegram.js').Telegram,
      adapters: [spy],
      now,
    });

    // The DB must still hold the resolved title (sticky-name guard) — sanity check.
    const [subjectRow] = await db
      .select()
      .from(offers)
      .where(and(eq(offers.source, 'dv'), eq(offers.sourceOfferKey, 'dv-subject')));
    expect(subjectRow?.title).toBe('Creek Hotel Resort');

    // OBSERVABLE outcome of runScan itself (not a test-body recomputation): a hot_deal fires and
    // its formatted Telegram message carries the "hotel" reference label + baseline. That label
    // is only reachable if run.ts's internal DiscountResult.reference resolved to 'hotel', which
    // in turn only happens if processOffers built its hotel-bucket query from the PERSISTED title
    // ("Creek Hotel Resort", matching the 4 siblings' hotel_key) rather than the raw incoming
    // placeholder ("Hotel 320645", which shares no hotel_key with any seeded row). If run.ts used
    // the raw incoming title, the hotel pool would come back empty, DiscountResult.reference would
    // fall through to 'market' (or null — no market bucket is seeded here), and neither the
    // "vs. tento hotel" label nor the exact −43 % / baseline figure below would appear.
    expect(summary.notificationsSent).toBe(1);
    const hot = tg.messages.find((m) => m.includes('🔥'));
    expect(hot).toBeDefined();
    expect(hot).toContain('vs. tento hotel 21 000 Kč'); // baseline = 3000/night median × 7 nights
    expect(hot).toContain('−43 %'); // round((3000-1714)/3000*100), same math as scenario 14
    expect(hot).not.toMatch(/vs\. (30denní medián|Omnibus|Řecko|Kréta)/);

    const logs = await db
      .select()
      .from(notificationsLog)
      .where(and(eq(notificationsLog.offerId, subjectRow!.id), eq(notificationsLog.type, 'hot_deal')));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.priceAtSend).toBe(12000);
  });
});
