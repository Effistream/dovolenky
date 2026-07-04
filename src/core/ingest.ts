import { and, eq, notInArray, desc } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { offers, priceSnapshots } from './db/schema.js';
import type { NormalizedOffer } from './types.js';

const HEARTBEAT_MS = 24 * 60 * 60 * 1000;
const MAX_MISSES = 2;

export interface IngestResult {
  offerId: number;
  isNew: boolean;
  snapshotWritten: boolean;
  previousPrice: number | null;
}

export async function ingestOffer(db: Db, offer: NormalizedOffer, now: Date = new Date()): Promise<IngestResult> {
  const nowIso = now.toISOString();

  const [existing] = await db
    .select()
    .from(offers)
    .where(and(eq(offers.source, offer.source), eq(offers.sourceOfferKey, offer.sourceOfferKey)));

  if (!existing) {
    const [inserted] = await db
      .insert(offers)
      .values({
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
      })
      .returning({ id: offers.id });

    const offerId = inserted!.id;

    await db.insert(priceSnapshots).values({
      offerId,
      capturedAt: nowIso,
      pricePerPerson: offer.pricePerPerson,
      priceTotal: offer.priceTotal,
      claimedOriginalPrice: offer.claimedOriginalPrice,
      claimedDiscountPct: offer.claimedDiscountPct,
      omnibusLowestPrice: offer.omnibusLowestPrice,
    });

    return { offerId, isNew: true, snapshotWritten: true, previousPrice: null };
  }

  const offerId = existing.id;

  const [latestSnapshot] = await db
    .select()
    .from(priceSnapshots)
    .where(eq(priceSnapshots.offerId, offerId))
    .orderBy(desc(priceSnapshots.id))
    .limit(1);

  const previousPrice = latestSnapshot ? latestSnapshot.pricePerPerson : null;

  const priceChanged = latestSnapshot ? latestSnapshot.pricePerPerson !== offer.pricePerPerson : true;
  const snapshotStale = latestSnapshot
    ? now.getTime() - new Date(latestSnapshot.capturedAt).getTime() > HEARTBEAT_MS
    : true;
  const shouldWriteSnapshot = priceChanged || snapshotStale;

  if (shouldWriteSnapshot) {
    await db.insert(priceSnapshots).values({
      offerId,
      capturedAt: nowIso,
      pricePerPerson: offer.pricePerPerson,
      priceTotal: offer.priceTotal,
      claimedOriginalPrice: offer.claimedOriginalPrice,
      claimedDiscountPct: offer.claimedDiscountPct,
      omnibusLowestPrice: offer.omnibusLowestPrice,
    });
  }

  await db
    .update(offers)
    .set({
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
      lastSeenAt: nowIso,
      active: true,
      misses: 0,
    })
    .where(eq(offers.id, offerId));

  return { offerId, isNew: false, snapshotWritten: shouldWriteSnapshot, previousPrice };
}

export async function markMissedOffers(
  db: Db,
  source: string,
  seenKeys: string[],
  // `now` is accepted for interface symmetry with ingestOffer / future use
  // (e.g. a last-checked timestamp); the current schema has no column for it.
  _now: Date = new Date(),
): Promise<void> {
  const missedWhere = seenKeys.length > 0
    ? and(eq(offers.source, source), notInArray(offers.sourceOfferKey, seenKeys))
    : eq(offers.source, source);

  const missed = await db.select().from(offers).where(missedWhere);

  for (const row of missed) {
    const nextMisses = row.misses + 1;
    await db
      .update(offers)
      .set({
        misses: nextMisses,
        active: nextMisses >= MAX_MISSES ? false : row.active,
      })
      .where(eq(offers.id, row.id));
  }
}
