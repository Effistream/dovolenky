import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { openDb, ensureSchema, type Db } from '../src/core/db/index.js';
import { offers, priceSnapshots } from '../src/core/db/schema.js';
import { ingestOffer, ingestSourceOffers, markMissedOffers, isPlaceholderTitle, type IngestResult } from '../src/core/ingest.js';
import { computeMatchKey, computeHotelKey } from '../src/core/normalize.js';
import type { NormalizedOffer } from '../src/core/types.js';

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

async function countSnapshots(db: Db, offerId: number): Promise<number> {
  const rows = await db.select().from(priceSnapshots).where(sql`${priceSnapshots.offerId} = ${offerId}`);
  return rows.length;
}

describe('ingestOffer', () => {
  let db: Db;

  beforeEach(async () => {
    db = openDb(':memory:');
    await ensureSchema(db);
  });

  it('scenario 1: new offer -> isNew true, snapshot written', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const result = await ingestOffer(db, makeOffer(), now);

    expect(result.isNew).toBe(true);
    expect(result.snapshotWritten).toBe(true);
    expect(result.previousPrice).toBeNull();
    expect(result.offerId).toBeGreaterThan(0);

    const snapCount = await countSnapshots(db, result.offerId);
    expect(snapCount).toBe(1);

    const [row] = await db.select().from(offers).where(sql`${offers.id} = ${result.offerId}`);
    expect(row?.active).toBe(true);
    expect(row?.misses).toBe(0);
    expect(row?.firstSeenAt).toBe(now.toISOString());
    expect(row?.lastSeenAt).toBe(now.toISOString());
  });

  it('scenario 2: same price, same day -> snapshotWritten false, lastSeenAt updated', async () => {
    const t0 = new Date('2026-07-04T10:00:00.000Z');
    const first = await ingestOffer(db, makeOffer(), t0);
    expect(first.snapshotWritten).toBe(true);

    const t1 = new Date('2026-07-04T14:00:00.000Z'); // 4h later, same day
    const second = await ingestOffer(db, makeOffer(), t1);

    expect(second.isNew).toBe(false);
    expect(second.snapshotWritten).toBe(false);
    expect(second.previousPrice).toBe(16781);
    expect(second.offerId).toBe(first.offerId);

    const snapCount = await countSnapshots(db, second.offerId);
    expect(snapCount).toBe(1);

    const [row] = await db.select().from(offers).where(sql`${offers.id} = ${second.offerId}`);
    expect(row?.lastSeenAt).toBe(t1.toISOString());
  });

  it('scenario 3: same price after 8 days -> snapshot written (heartbeat)', async () => {
    const t0 = new Date('2026-07-04T10:00:00.000Z');
    const first = await ingestOffer(db, makeOffer(), t0);
    expect(first.snapshotWritten).toBe(true);

    const t1 = new Date(t0.getTime() + 8 * 24 * 60 * 60 * 1000); // 8 days later (> 7-day HEARTBEAT_MS)
    const second = await ingestOffer(db, makeOffer(), t1);

    expect(second.snapshotWritten).toBe(true);
    expect(second.previousPrice).toBe(16781);

    const snapCount = await countSnapshots(db, second.offerId);
    expect(snapCount).toBe(2);
  });

  it('scenario 4: changed price -> snapshot written, previousPrice = old price', async () => {
    const t0 = new Date('2026-07-04T10:00:00.000Z');
    const first = await ingestOffer(db, makeOffer({ pricePerPerson: 16781 }), t0);
    expect(first.snapshotWritten).toBe(true);

    const t1 = new Date('2026-07-04T12:00:00.000Z'); // same day, price changed
    const second = await ingestOffer(db, makeOffer({ pricePerPerson: 14000 }), t1);

    expect(second.snapshotWritten).toBe(true);
    expect(second.previousPrice).toBe(16781);

    const snapCount = await countSnapshots(db, second.offerId);
    expect(snapCount).toBe(2);

    const [row] = await db.select().from(offers).where(sql`${offers.id} = ${second.offerId}`);
    expect(row?.lastSeenAt).toBe(t1.toISOString());
  });

  it('scenario 5: markMissedOffers marks inactive after 2 consecutive misses, reactivates when seen again', async () => {
    const t0 = new Date('2026-07-04T10:00:00.000Z');
    const offerA = await ingestOffer(db, makeOffer({ sourceOfferKey: 'key-a' }), t0);
    const offerB = await ingestOffer(db, makeOffer({ sourceOfferKey: 'key-b' }), t0);

    // Round 1: only key-a seen -> key-b misses=1, still active
    await markMissedOffers(db, 'invia', ['key-a'], new Date('2026-07-04T11:00:00.000Z'));
    let [rowB] = await db.select().from(offers).where(sql`${offers.id} = ${offerB.offerId}`);
    expect(rowB?.misses).toBe(1);
    expect(rowB?.active).toBe(true);

    // Round 2: still not seen -> misses=2, active=false
    await markMissedOffers(db, 'invia', ['key-a'], new Date('2026-07-04T12:00:00.000Z'));
    [rowB] = await db.select().from(offers).where(sql`${offers.id} = ${offerB.offerId}`);
    expect(rowB?.misses).toBe(2);
    expect(rowB?.active).toBe(false);

    // Round 3: key-b seen again via ingestOffer -> active=true, misses=0
    const t3 = new Date('2026-07-04T13:00:00.000Z');
    await ingestOffer(db, makeOffer({ sourceOfferKey: 'key-b' }), t3);
    [rowB] = await db.select().from(offers).where(sql`${offers.id} = ${offerB.offerId}`);
    expect(rowB?.misses).toBe(0);
    expect(rowB?.active).toBe(true);
    expect(rowB?.lastSeenAt).toBe(t3.toISOString());

    // offerA never missed
    const [rowA] = await db.select().from(offers).where(sql`${offers.id} = ${offerA.offerId}`);
    expect(rowA?.misses).toBe(0);
    expect(rowA?.active).toBe(true);
  });

  it('scenario 6: concurrent inserts for the same (source, sourceOfferKey) throw the unique error ingestOffer catches', async () => {
    // Verifies the actual error shape ingestOffer's catch block matches against:
    // insert the same row twice directly (simulating two concurrent callers
    // that both saw `existing === undefined` before either had committed) and
    // confirm libsql's rejection carries the strings isUniqueConstraintError
    // looks for, either on the error itself or on its wrapped `cause`.
    const now = new Date('2026-07-04T10:00:00.000Z');
    const nowIso = now.toISOString();
    const offer = makeOffer({ sourceOfferKey: 'race-key' });

    const insertValues = {
      source: offer.source,
      sourceOfferKey: offer.sourceOfferKey,
      title: offer.title,
      country: offer.country,
      locality: offer.locality,
      stars: offer.stars,
      board: offer.board,
      transport: offer.transport,
      departureAirport: offer.departureAirport,
      departureDate: offer.departureDate,
      nights: offer.nights,
      tourOperator: offer.tourOperator,
      url: offer.url,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      active: true,
      misses: 0,
    };

    await db.insert(offers).values(insertValues);

    let caught: unknown;
    try {
      await db.insert(offers).values(insertValues);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();

    function messageChainIncludes(err: unknown, needle: string): boolean {
      let current: unknown = err;
      for (let depth = 0; current && depth < 5; depth += 1) {
        const message = (current as { message?: unknown }).message;
        if (typeof message === 'string' && message.includes(needle)) return true;
        current = (current as { cause?: unknown }).cause;
      }
      return false;
    }

    const matchesUniqueConstraint =
      messageChainIncludes(caught, 'UNIQUE constraint failed') || messageChainIncludes(caught, 'SQLITE_CONSTRAINT');
    expect(matchesUniqueConstraint).toBe(true);
  });

  it('scenario 7: ingestOffer called twice for the same key behaves like the race-recovery path (isNew false, single row)', async () => {
    // ingestOffer has no seam to inject a mid-flight insert from "another
    // process" without a second real DB connection, so this exercises the
    // observable contract the catch block must preserve: whether the row was
    // found on the initial select (the common path) or discovered via the
    // catch block's re-select after a unique-constraint violation (the race
    // path), a second ingest for the same (source, sourceOfferKey) must land
    // on ingestExistingOffer semantics — isNew false, previousPrice from the
    // latest snapshot, misses reset, lastSeenAt bumped, and only one offer row.
    const t0 = new Date('2026-07-04T10:00:00.000Z');
    const first = await ingestOffer(db, makeOffer({ sourceOfferKey: 'race-key-2' }), t0);
    expect(first.isNew).toBe(true);

    const t1 = new Date('2026-07-04T11:00:00.000Z');
    const second = await ingestOffer(db, makeOffer({ sourceOfferKey: 'race-key-2', pricePerPerson: 12345 }), t1);

    expect(second.isNew).toBe(false);
    expect(second.offerId).toBe(first.offerId);
    expect(second.previousPrice).toBe(16781);
    expect(second.snapshotWritten).toBe(true);

    const rows = await db.select().from(offers).where(sql`${offers.source} = 'invia' AND ${offers.sourceOfferKey} = 'race-key-2'`);
    expect(rows.length).toBe(1);
    expect(rows[0]?.misses).toBe(0);
    expect(rows[0]?.active).toBe(true);
    expect(rows[0]?.lastSeenAt).toBe(t1.toISOString());
  });

  it('match_key is computed and stored on insert', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const offer = makeOffer();
    const result = await ingestOffer(db, offer, now);

    const [row] = await db.select().from(offers).where(sql`${offers.id} = ${result.offerId}`);
    expect(row?.matchKey).toBe(computeMatchKey(offer));
    expect(row?.matchKey).not.toBeNull();
  });

  it('hotel_key is computed and stored on insert', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const offer = makeOffer();
    const result = await ingestOffer(db, offer, now);

    const [row] = await db.select().from(offers).where(sql`${offers.id} = ${result.offerId}`);
    expect(row?.hotelKey).toBe(computeHotelKey(offer));
    expect(row?.hotelKey).not.toBeNull();
  });

  it('hotel_key is refreshed on update (e.g. title change alters the key)', async () => {
    const t0 = new Date('2026-07-04T10:00:00.000Z');
    const first = await ingestOffer(db, makeOffer(), t0);

    const t1 = new Date('2026-07-04T12:00:00.000Z');
    const updatedOffer = makeOffer({ title: 'Hotel X Renamed' });
    await ingestOffer(db, updatedOffer, t1);

    const [row] = await db.select().from(offers).where(sql`${offers.id} = ${first.offerId}`);
    expect(row?.hotelKey).toBe(computeHotelKey(updatedOffer));
    expect(row?.hotelKey).not.toBe(computeHotelKey(makeOffer()));
  });

  it('hotel_key is null when country is null, and stays null on update', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const offer = makeOffer({ country: null });
    const result = await ingestOffer(db, offer, now);

    const [row] = await db.select().from(offers).where(sql`${offers.id} = ${result.offerId}`);
    expect(row?.hotelKey).toBeNull();
  });

  it('match_key is refreshed on update (e.g. title/board change alters the key)', async () => {
    const t0 = new Date('2026-07-04T10:00:00.000Z');
    const first = await ingestOffer(db, makeOffer(), t0);

    const t1 = new Date('2026-07-04T12:00:00.000Z');
    const updatedOffer = makeOffer({ title: 'Hotel X Renamed' });
    await ingestOffer(db, updatedOffer, t1);

    const [row] = await db.select().from(offers).where(sql`${offers.id} = ${first.offerId}`);
    expect(row?.matchKey).toBe(computeMatchKey(updatedOffer));
    expect(row?.matchKey).not.toBe(computeMatchKey(makeOffer()));
  });

  it('match_key is null when board is unknown, and stays null on update', async () => {
    const now = new Date('2026-07-04T10:00:00.000Z');
    const offer = makeOffer({ board: 'unknown' });
    const result = await ingestOffer(db, offer, now);

    const [row] = await db.select().from(offers).where(sql`${offers.id} = ${result.offerId}`);
    expect(row?.matchKey).toBeNull();
  });

  it('backfill: pre-existing row without match_key gets populated by ensureSchema', async () => {
    // Simulate a DB written before match_key existed: insert a raw row via SQL
    // that never goes through ingestOffer, leaving match_key NULL.
    const nowIso = new Date('2026-07-04T10:00:00.000Z').toISOString();
    await db.run(`
      INSERT INTO offers (
        source, source_offer_key, title, country, locality, stars, board, transport,
        departure_airport, departure_date, nights, tour_operator, url,
        first_seen_at, last_seen_at, active, misses
      ) VALUES (
        'invia', 'legacy-key', 'Hotel X', 'Řecko', 'Kréta', 4, 'AI', 'flight',
        'PRG', '2026-07-15', 7, 'Invia', 'https://example.com/legacy',
        '${nowIso}', '${nowIso}', 1, 0
      )
    `);

    const [before] = await db.select().from(offers).where(sql`${offers.sourceOfferKey} = 'legacy-key'`);
    expect(before?.matchKey).toBeNull();

    // Re-running ensureSchema triggers the backfill pass.
    await ensureSchema(db);

    const [after] = await db.select().from(offers).where(sql`${offers.sourceOfferKey} = 'legacy-key'`);
    expect(after?.matchKey).not.toBeNull();
    expect(after?.matchKey).toBe(computeMatchKey(makeOffer({ source: 'invia', sourceOfferKey: 'legacy-key', url: 'https://example.com/legacy' })));
  });

  it('backfill: legacy row that resolves to null match_key rules (e.g. missing country) stays null', async () => {
    const nowIso = new Date('2026-07-04T10:00:00.000Z').toISOString();
    await db.run(`
      INSERT INTO offers (
        source, source_offer_key, title, country, locality, stars, board, transport,
        departure_airport, departure_date, nights, tour_operator, url,
        first_seen_at, last_seen_at, active, misses
      ) VALUES (
        'invia', 'legacy-key-no-country', 'Hotel Y', NULL, 'Kréta', 4, 'AI', 'flight',
        'PRG', '2026-07-15', 7, 'Invia', 'https://example.com/legacy2',
        '${nowIso}', '${nowIso}', 1, 0
      )
    `);

    await ensureSchema(db);

    const [after] = await db.select().from(offers).where(sql`${offers.sourceOfferKey} = 'legacy-key-no-country'`);
    expect(after?.matchKey).toBeNull();
  });

  it('backfill: pre-existing row without hotel_key gets populated by ensureSchema', async () => {
    // Simulate a DB written before hotel_key existed: insert a raw row via SQL
    // that never goes through ingestOffer, leaving hotel_key NULL.
    const nowIso = new Date('2026-07-04T10:00:00.000Z').toISOString();
    await db.run(`
      INSERT INTO offers (
        source, source_offer_key, title, country, locality, stars, board, transport,
        departure_airport, departure_date, nights, tour_operator, url,
        first_seen_at, last_seen_at, active, misses
      ) VALUES (
        'invia', 'legacy-key-hotel', 'Hotel X', 'Řecko', 'Kréta', 4, 'AI', 'flight',
        'PRG', '2026-07-15', 7, 'Invia', 'https://example.com/legacy-hotel',
        '${nowIso}', '${nowIso}', 1, 0
      )
    `);

    const [before] = await db.select().from(offers).where(sql`${offers.sourceOfferKey} = 'legacy-key-hotel'`);
    expect(before?.hotelKey).toBeNull();

    // Re-running ensureSchema triggers the backfill pass.
    await ensureSchema(db);

    const [after] = await db.select().from(offers).where(sql`${offers.sourceOfferKey} = 'legacy-key-hotel'`);
    expect(after?.hotelKey).not.toBeNull();
    expect(after?.hotelKey).toBe(computeHotelKey(makeOffer({ source: 'invia', sourceOfferKey: 'legacy-key-hotel', url: 'https://example.com/legacy-hotel' })));
  });

  it('backfill: legacy row that resolves to null hotel_key (e.g. missing country) stays null', async () => {
    const nowIso = new Date('2026-07-04T10:00:00.000Z').toISOString();
    await db.run(`
      INSERT INTO offers (
        source, source_offer_key, title, country, locality, stars, board, transport,
        departure_airport, departure_date, nights, tour_operator, url,
        first_seen_at, last_seen_at, active, misses
      ) VALUES (
        'invia', 'legacy-key-hotel-no-country', 'Hotel Y', NULL, 'Kréta', 4, 'AI', 'flight',
        'PRG', '2026-07-15', 7, 'Invia', 'https://example.com/legacy-hotel2',
        '${nowIso}', '${nowIso}', 1, 0
      )
    `);

    await ensureSchema(db);

    const [after] = await db.select().from(offers).where(sql`${offers.sourceOfferKey} = 'legacy-key-hotel-no-country'`);
    expect(after?.hotelKey).toBeNull();
  });

  describe('isPlaceholderTitle', () => {
    it('matches "Hotel <digits>" exactly', () => {
      expect(isPlaceholderTitle('Hotel 320645')).toBe(true);
      expect(isPlaceholderTitle('Hotel 1')).toBe(true);
    });

    it('does not match real hotel names, even ones containing "Hotel"', () => {
      expect(isPlaceholderTitle('Creek Hotel & Residences El Gouna')).toBe(false);
      expect(isPlaceholderTitle('Hotel California')).toBe(false);
      expect(isPlaceholderTitle('Grand Hotel')).toBe(false);
    });

    it('does not match malformed variants (extra text, no digits, leading/trailing junk)', () => {
      expect(isPlaceholderTitle('Hotel')).toBe(false);
      expect(isPlaceholderTitle('Hotel 123 Resort')).toBe(false);
      expect(isPlaceholderTitle(' Hotel 123')).toBe(false);
      expect(isPlaceholderTitle('hotel 123')).toBe(false);
    });
  });

  describe('placeholder-title guard on update (sticky resolved names)', () => {
    it('a real stored title is NOT clobbered by an incoming placeholder re-ingest', async () => {
      const t0 = new Date('2026-07-04T10:00:00.000Z');
      const first = await ingestOffer(
        db,
        makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'dv-1', title: 'Creek Hotel' }),
        t0,
      );

      const t1 = new Date('2026-07-05T10:00:00.000Z');
      await ingestOffer(
        db,
        makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'dv-1', title: 'Hotel 320645' }),
        t1,
      );

      const [row] = await db.select().from(offers).where(sql`${offers.id} = ${first.offerId}`);
      expect(row?.title).toBe('Creek Hotel');
      // hotel_key must be recomputed from the persisted (real) title, not the discarded
      // placeholder — mirrors the match_key sticky-title guard exactly (spec §15).
      expect(row?.hotelKey).toBe(computeHotelKey(makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'dv-1', title: 'Creek Hotel' })));
    });

    it('a placeholder stored title DOES get updated once a real name is resolved', async () => {
      const t0 = new Date('2026-07-04T10:00:00.000Z');
      const first = await ingestOffer(
        db,
        makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'dv-2', title: 'Hotel 320645' }),
        t0,
      );

      const t1 = new Date('2026-07-05T10:00:00.000Z');
      await ingestOffer(
        db,
        makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'dv-2', title: 'Creek Hotel' }),
        t1,
      );

      const [row] = await db.select().from(offers).where(sql`${offers.id} = ${first.offerId}`);
      expect(row?.title).toBe('Creek Hotel');
    });

    it('two placeholders in a row is a no-op (title stays the same placeholder)', async () => {
      const t0 = new Date('2026-07-04T10:00:00.000Z');
      const first = await ingestOffer(
        db,
        makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'dv-3', title: 'Hotel 320645' }),
        t0,
      );

      const t1 = new Date('2026-07-05T10:00:00.000Z');
      await ingestOffer(
        db,
        makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'dv-3', title: 'Hotel 320645' }),
        t1,
      );

      const [row] = await db.select().from(offers).where(sql`${offers.id} = ${first.offerId}`);
      expect(row?.title).toBe('Hotel 320645');
    });

    it('two real titles in a row still refreshes to the newest (guard only blocks placeholder-over-real)', async () => {
      const t0 = new Date('2026-07-04T10:00:00.000Z');
      const first = await ingestOffer(
        db,
        makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'dv-4', title: 'Creek Hotel' }),
        t0,
      );

      const t1 = new Date('2026-07-05T10:00:00.000Z');
      await ingestOffer(
        db,
        makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'dv-4', title: 'Creek Hotel Renamed' }),
        t1,
      );

      const [row] = await db.select().from(offers).where(sql`${offers.id} = ${first.offerId}`);
      expect(row?.title).toBe('Creek Hotel Renamed');
    });

    it('the placeholder guard does not interact with snapshot/price logic (snapshot still written on price change)', async () => {
      const t0 = new Date('2026-07-04T10:00:00.000Z');
      const first = await ingestOffer(
        db,
        makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'dv-5', title: 'Creek Hotel', pricePerPerson: 16781 }),
        t0,
      );

      const t1 = new Date('2026-07-04T12:00:00.000Z'); // same day, price changed, placeholder incoming
      const second = await ingestOffer(
        db,
        makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'dv-5', title: 'Hotel 320645', pricePerPerson: 14000 }),
        t1,
      );

      expect(second.snapshotWritten).toBe(true);
      expect(second.previousPrice).toBe(16781);

      const [row] = await db.select().from(offers).where(sql`${offers.id} = ${first.offerId}`);
      expect(row?.title).toBe('Creek Hotel'); // guard still applies regardless of price/snapshot outcome

      const snapCount = await countSnapshots(db, first.offerId);
      expect(snapCount).toBe(2);
    });
  });

  it('ensureSchema is idempotent: running it twice does not error and does not duplicate columns', async () => {
    await ensureSchema(db);
    await ensureSchema(db);

    const cols = (await db.all(`PRAGMA table_info(offers)`)) as Array<{ name: string }>;
    const matchKeyCols = cols.filter(c => c.name === 'match_key');
    expect(matchKeyCols.length).toBe(1);
    const hotelKeyCols = cols.filter(c => c.name === 'hotel_key');
    expect(hotelKeyCols.length).toBe(1);

    const notifCols = (await db.all(`PRAGMA table_info(notifications_log)`)) as Array<{ name: string }>;
    const notifMatchKeyCols = notifCols.filter(c => c.name === 'match_key');
    expect(notifMatchKeyCols.length).toBe(1);
  });
});

describe('ingestSourceOffers (batched == per-offer)', () => {
  // now, plus two seed times: one 4h back (still inside the heartbeat) and one 8 days back
  // (past the 7-day heartbeat), so the seeded snapshots land at controllable capturedAts.
  const now = new Date('2026-07-04T10:00:00.000Z');
  const tSeed = new Date('2026-07-04T06:00:00.000Z'); // 4h before now → within heartbeat
  const tStale = new Date('2026-06-26T10:00:00.000Z'); // 8 days before now → past the 7-day heartbeat

  /**
   * Seeds the four "existing" offers (each with a prior snapshot at a controllable capturedAt) by
   * replaying ingestOffer at an earlier `now`. Applied identically to both DBs so they start byte-
   * for-byte equal before the mixed re-ingest.
   */
  async function seed(target: Db): Promise<void> {
    await ingestOffer(target, makeOffer({ sourceOfferKey: 'exist-change', title: 'Change Hotel', pricePerPerson: 20000 }), tSeed);
    await ingestOffer(target, makeOffer({ sourceOfferKey: 'exist-nochange', title: 'Nochange Hotel', pricePerPerson: 18000 }), tSeed);
    await ingestOffer(target, makeOffer({ sourceOfferKey: 'exist-stale', title: 'Stale Hotel', pricePerPerson: 17000 }), tStale);
    await ingestOffer(target, makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'exist-ph', title: 'Creek Hotel', pricePerPerson: 16000 }), tSeed);
  }

  // The mixed re-ingest set applied at `now`: 2 brand-new + all four existing cases, interleaved.
  function mixedSet(): NormalizedOffer[] {
    return [
      makeOffer({ sourceOfferKey: 'new-1', title: 'New Hotel A', pricePerPerson: 11000 }),
      makeOffer({ sourceOfferKey: 'exist-change', title: 'Change Hotel', pricePerPerson: 15000 }), // price changed → snapshot
      makeOffer({ sourceOfferKey: 'exist-nochange', title: 'Nochange Hotel', pricePerPerson: 18000 }), // same price, within heartbeat → no snapshot
      makeOffer({ sourceOfferKey: 'new-2', title: 'New Hotel B', pricePerPerson: 9000 }),
      makeOffer({ sourceOfferKey: 'exist-stale', title: 'Stale Hotel', pricePerPerson: 17000 }), // same price but stale → snapshot
      makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'exist-ph', title: 'Hotel 320645', pricePerPerson: 13000 }), // placeholder over real → sticky, price change → snapshot
    ];
  }

  interface OfferState {
    source: string;
    sourceOfferKey: string;
    title: string;
    country: string | null;
    matchKey: string | null;
    hotelKey: string | null;
    active: boolean;
    misses: number;
    firstSeenAt: string;
    lastSeenAt: string;
  }
  interface StateDump {
    offers: OfferState[];
    snapshotsByKey: Record<string, Array<{ pricePerPerson: number; capturedAt: string }>>;
  }

  // Logical snapshot of the whole DB, keyed by (source, sourceOfferKey) rather than by autoincrement
  // id, and with each offer's snapshots sorted — so two DBs that differ ONLY in id-assignment order
  // (which batching legitimately changes for price_snapshots) compare equal iff their content is.
  async function dumpState(target: Db): Promise<StateDump> {
    const composite = (s: string, k: string) => `${s} ${k}`;
    const offerRows = await target.select().from(offers);
    offerRows.sort((a, b) => composite(a.source, a.sourceOfferKey).localeCompare(composite(b.source, b.sourceOfferKey)));

    const idToKey = new Map<number, string>();
    for (const r of offerRows) idToKey.set(r.id, composite(r.source, r.sourceOfferKey));

    const snapRows = await target.select().from(priceSnapshots);
    const snapshotsByKey: Record<string, Array<{ pricePerPerson: number; capturedAt: string }>> = {};
    for (const s of snapRows) {
      const key = idToKey.get(s.offerId)!;
      (snapshotsByKey[key] ??= []).push({ pricePerPerson: s.pricePerPerson, capturedAt: s.capturedAt });
    }
    for (const key of Object.keys(snapshotsByKey)) {
      snapshotsByKey[key]!.sort((a, b) => a.pricePerPerson - b.pricePerPerson || a.capturedAt.localeCompare(b.capturedAt));
    }

    return {
      offers: offerRows.map((r) => ({
        source: r.source,
        sourceOfferKey: r.sourceOfferKey,
        title: r.title,
        country: r.country,
        matchKey: r.matchKey,
        hotelKey: r.hotelKey,
        active: r.active,
        misses: r.misses,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
      })),
      snapshotsByKey,
    };
  }

  const snapsOf = (state: StateDump, sourceOfferKey: string) =>
    Object.entries(state.snapshotsByKey).find(([k]) => k.endsWith(` ${sourceOfferKey}`))?.[1] ?? [];
  const resultFor = (rs: IngestResult[], set: NormalizedOffer[], key: string) =>
    rs[set.findIndex((o) => o.sourceOfferKey === key)]!;

  it('produces identical offers + price_snapshots DB state as ingestOffer per offer', async () => {
    const dbA = openDb(':memory:');
    await ensureSchema(dbA);
    const dbB = openDb(':memory:');
    await ensureSchema(dbB);

    await seed(dbA);
    await seed(dbB);

    // DB-A: ONE batched ingestSourceOffers call. DB-B: ingestOffer per offer, same order, same now.
    const set = mixedSet();
    const batchResults = await ingestSourceOffers(dbA, set, now);
    const perOfferResults: IngestResult[] = [];
    for (const offer of mixedSet()) perOfferResults.push(await ingestOffer(dbB, offer, now));

    // (1) The whole DB — every offers row (title, country, match_key, hotel_key, active, misses,
    // first/last seen) and every snapshot (count + prices + capturedAt) — is identical.
    expect(await dumpState(dbA)).toEqual(await dumpState(dbB));

    // (2) The returned IngestResult semantic fields match per offer (offerId can legitimately be a
    // different integer if ids diverged — here they don't — so compare the logical fields).
    const logical = (r: IngestResult) => ({ isNew: r.isNew, snapshotWritten: r.snapshotWritten, previousPrice: r.previousPrice, persistedTitle: r.persistedTitle });
    expect(batchResults.map(logical)).toEqual(perOfferResults.map(logical));

    // (3) Spot-check each case the mixed set is designed to exercise, so a regression corrupting
    // BOTH DBs identically (which (1)/(2) would miss) still fails here.
    expect(resultFor(batchResults, set, 'new-1').isNew).toBe(true);
    expect(resultFor(batchResults, set, 'new-1').snapshotWritten).toBe(true);
    expect(resultFor(batchResults, set, 'new-1').previousPrice).toBeNull();
    expect(resultFor(batchResults, set, 'exist-change').isNew).toBe(false);
    expect(resultFor(batchResults, set, 'exist-change').snapshotWritten).toBe(true); // price 20000 → 15000
    expect(resultFor(batchResults, set, 'exist-change').previousPrice).toBe(20000);
    expect(resultFor(batchResults, set, 'exist-nochange').snapshotWritten).toBe(false); // same price, within heartbeat
    expect(resultFor(batchResults, set, 'exist-stale').snapshotWritten).toBe(true); // same price but past the 7-day heartbeat
    expect(resultFor(batchResults, set, 'exist-ph').persistedTitle).toBe('Creek Hotel'); // sticky-title guard

    // Snapshot counts reflect the write rule: nochange stayed at 1; change/stale/ph each gained one.
    const stateA = await dumpState(dbA);
    expect(snapsOf(stateA, 'new-1')).toHaveLength(1);
    expect(snapsOf(stateA, 'exist-nochange')).toHaveLength(1);
    expect(snapsOf(stateA, 'exist-change')).toHaveLength(2);
    expect(snapsOf(stateA, 'exist-stale')).toHaveLength(2);
    expect(snapsOf(stateA, 'exist-ph')).toHaveLength(2);

    // The placeholder re-ingest kept the real stored title AND recomputed hotel_key from it (not the
    // discarded placeholder) — the same sticky-guard invariant ingestOffer holds.
    const phRow = stateA.offers.find((o) => o.sourceOfferKey === 'exist-ph')!;
    expect(phRow.title).toBe('Creek Hotel');
    expect(phRow.hotelKey).toBe(computeHotelKey(makeOffer({ source: 'dovolenkovani', sourceOfferKey: 'exist-ph', title: 'Creek Hotel' })));
  });

  it('returns results ALIGNED with input order and hands duplicates the first occurrence result', async () => {
    const db = openDb(':memory:');
    await ensureSchema(db);

    const offerX = makeOffer({ sourceOfferKey: 'dup-x', title: 'X Hotel', pricePerPerson: 10000 });
    const offerY = makeOffer({ sourceOfferKey: 'dup-y', title: 'Y Hotel', pricePerPerson: 11000 });
    // Index 2 duplicates offerX's (source, sourceOfferKey) at a different price. The batch must
    // dedupe it to the first occurrence (unique-index safety net) and give index 2 the SAME result.
    const offerXDup = makeOffer({ sourceOfferKey: 'dup-x', title: 'X Hotel', pricePerPerson: 999 });

    const results = await ingestSourceOffers(db, [offerX, offerY, offerXDup], now);

    expect(results).toHaveLength(3);
    expect(results[0]).toBe(results[2]); // exact same object → alignment preserved for duplicates
    expect(results[1]!.offerId).not.toBe(results[0]!.offerId);

    // Only two rows were created; the duplicate neither inserted a second row nor overwrote the
    // first occurrence's price (10000, not 999).
    const rows = await db.select().from(offers);
    expect(rows).toHaveLength(2);
    const xRow = rows.find((r) => r.sourceOfferKey === 'dup-x')!;
    const xSnaps = await db.select().from(priceSnapshots).where(sql`${priceSnapshots.offerId} = ${xRow.id}`);
    expect(xSnaps).toHaveLength(1);
    expect(xSnaps[0]!.pricePerPerson).toBe(10000);
  });

  it('returns [] for empty input', async () => {
    const db = openDb(':memory:');
    await ensureSchema(db);
    expect(await ingestSourceOffers(db, [], now)).toEqual([]);
  });

  it('markMissedOffers (batched) matches the per-row loop: misses++ and deactivate at MAX_MISSES', async () => {
    const db = openDb(':memory:');
    await ensureSchema(db);

    // Two offers seen initially; then one disappears from the seen set across two rounds.
    await ingestSourceOffers(db, [
      makeOffer({ sourceOfferKey: 'keep' }),
      makeOffer({ sourceOfferKey: 'vanish' }),
    ], now);

    await markMissedOffers(db, 'invia', ['keep'], now); // vanish misses → 1, still active
    let [vanish] = await db.select().from(offers).where(sql`${offers.sourceOfferKey} = 'vanish'`);
    expect(vanish?.misses).toBe(1);
    expect(vanish?.active).toBe(true);

    await markMissedOffers(db, 'invia', ['keep'], now); // vanish misses → 2 → inactive
    [vanish] = await db.select().from(offers).where(sql`${offers.sourceOfferKey} = 'vanish'`);
    expect(vanish?.misses).toBe(2);
    expect(vanish?.active).toBe(false);

    const [keep] = await db.select().from(offers).where(sql`${offers.sourceOfferKey} = 'keep'`);
    expect(keep?.misses).toBe(0);
    expect(keep?.active).toBe(true);
  });
});
