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
});
