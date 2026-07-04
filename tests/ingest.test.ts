import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { openDb, ensureSchema, type Db } from '../src/core/db/index.js';
import { offers, priceSnapshots } from '../src/core/db/schema.js';
import { ingestOffer, markMissedOffers } from '../src/core/ingest.js';
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

  it('scenario 3: same price after 25h -> snapshot written (heartbeat)', async () => {
    const t0 = new Date('2026-07-04T10:00:00.000Z');
    const first = await ingestOffer(db, makeOffer(), t0);
    expect(first.snapshotWritten).toBe(true);

    const t1 = new Date(t0.getTime() + 25 * 60 * 60 * 1000); // 25h later
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
});
