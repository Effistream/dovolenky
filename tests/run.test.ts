import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { openDb, ensureSchema, type Db } from '../src/core/db/index.js';
import { offers, priceSnapshots, notificationsLog, sourceRuns } from '../src/core/db/schema.js';
import type { AppConfig, Profile } from '../src/core/config.js';
import type { NormalizedOffer, SourceAdapter, SourceContext } from '../src/core/types.js';
import { HttpClient, SourceBlockedError } from '../src/core/http.js';
import { runScan } from '../src/core/run.js';

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
async function seedMarketBucket(db: Db, n: number, price: number, at: string): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const [row] = await db
      .insert(offers)
      .values({
        source: 'seed',
        sourceOfferKey: `seed-${i}`,
        title: `Seed Hotel ${i}`,
        country: 'Řecko',
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

  it('scenario 6: markMissedOffers runs per successful source', async () => {
    const now0 = new Date('2026-07-04T08:00:00.000Z');
    // First scan: offer present.
    await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [happyAdapter([makeOffer()])],
      now: now0,
    });
    // Second scan: happy returns nothing → miss #1.
    await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [happyAdapter([])],
      now: new Date('2026-07-04T10:00:00.000Z'),
    });
    // Third scan: still nothing → miss #2 → inactive.
    await runScan({
      db,
      cfg: makeConfig({ profiles: {} }),
      http: makeHttp(),
      telegram: null,
      adapters: [happyAdapter([])],
      now: new Date('2026-07-04T12:00:00.000Z'),
    });

    const [row] = await db
      .select()
      .from(offers)
      .where(and(eq(offers.source, 'happy'), eq(offers.sourceOfferKey, 'hotel-hot-2026-08-15')));
    expect(row?.misses).toBe(2);
    expect(row?.active).toBe(false);
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

    // Three distinct hot offers, cap of 2 → one overflow.
    const o1 = makeOffer({ sourceOfferKey: 'k1', url: 'https://e.com/1', pricePerPerson: 10000 });
    const o2 = makeOffer({ sourceOfferKey: 'k2', url: 'https://e.com/2', pricePerPerson: 11000 });
    const o3 = makeOffer({ sourceOfferKey: 'k3', url: 'https://e.com/3', pricePerPerson: 12000 });

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
});
