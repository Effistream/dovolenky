import { and, eq, notInArray, desc } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { offers, priceSnapshots } from './db/schema.js';
import type { NormalizedOffer } from './types.js';
import { computeMatchKey } from './normalize.js';

const HEARTBEAT_MS = 24 * 60 * 60 * 1000;
const MAX_MISSES = 2;

// Matches the numeric fallback title adapters assign when a hotel/property name can't be
// resolved yet (e.g. dovolenkovani.ts's `Hotel <master_id>`). Shared source of truth so both the
// ingest guard below and any adapter/run.ts caller agree on what counts as "not a real name yet".
const PLACEHOLDER_TITLE_RE = /^Hotel\s+\d+$/;

/**
 * True iff `t` is a generic placeholder title (e.g. "Hotel 320645") rather than a real,
 * source-resolved name. Used by the ingest update path to make once-resolved names sticky: an
 * adapter's per-run resolution cap (e.g. dovolenkovani's 40-lookup ceiling) means a hotel name
 * resolved in one run can legitimately come back unresolved in a later run — this guard stops
 * that regression from clobbering the name already stored in the DB (2026-07-07 regression fix).
 */
export function isPlaceholderTitle(t: string): boolean {
  return PLACEHOLDER_TITLE_RE.test(t);
}

export interface IngestResult {
  offerId: number;
  isNew: boolean;
  snapshotWritten: boolean;
  previousPrice: number | null;
}

// Does `err` look like a libsql/SQLite unique-constraint violation? Checks the
// error's own message plus any wrapped `cause` chain, since libsql surfaces the
// "UNIQUE constraint failed" / "SQLITE_CONSTRAINT" text on the innermost cause
// rather than on the outer "Failed query: ..." error thrown by drizzle.
function isUniqueConstraintError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const message = (current as { message?: unknown }).message;
    const code = (current as { code?: unknown }).code;
    if (typeof message === 'string' && (message.includes('UNIQUE constraint failed') || message.includes('SQLITE_CONSTRAINT'))) {
      return true;
    }
    if (typeof code === 'string' && code.includes('SQLITE_CONSTRAINT')) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Apply the "existing offer" ingest semantics: write a new price snapshot when
// the price changed or the heartbeat interval elapsed, then refresh the offer
// row (lastSeenAt, misses reset, reactivate). Shared by the normal update path
// and by the race-recovery path in ingestOffer below.
async function ingestExistingOffer(
  db: Db,
  offerId: number,
  offer: NormalizedOffer,
  now: Date,
): Promise<IngestResult> {
  const nowIso = now.toISOString();

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

  // Sticky-name guard: never let a placeholder title (e.g. "Hotel 320645") overwrite a real,
  // already-resolved name. Adapters re-derive titles fresh every run and may only resolve a
  // capped number of unknown hotels per run (see dovolenkovani.ts), so a hotel resolved in run N
  // can legitimately come back as a placeholder in run N+1 — without this guard that would
  // silently revert the stored name (2026-07-07 regression). Any other combination (real->real,
  // placeholder->real, placeholder->placeholder) refreshes the title as before.
  const [existingRow] = await db.select({ title: offers.title }).from(offers).where(eq(offers.id, offerId));
  const incomingIsPlaceholder = isPlaceholderTitle(offer.title);
  const existingIsReal = existingRow ? !isPlaceholderTitle(existingRow.title) : false;
  const nextTitle = incomingIsPlaceholder && existingIsReal ? existingRow!.title : offer.title;
  // Recompute match_key from the title we're actually persisting (nextTitle), not the raw
  // incoming offer.title — otherwise a guarded-away placeholder would still poison the stored
  // match_key with a key derived from the discarded placeholder title.
  const offerForMatchKey = nextTitle === offer.title ? offer : { ...offer, title: nextTitle };

  await db
    .update(offers)
    .set({
      title: nextTitle,
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
      matchKey: computeMatchKey(offerForMatchKey),
    })
    .where(eq(offers.id, offerId));

  return { offerId, isNew: false, snapshotWritten: shouldWriteSnapshot, previousPrice };
}

export async function ingestOffer(db: Db, offer: NormalizedOffer, now: Date = new Date()): Promise<IngestResult> {
  const nowIso = now.toISOString();

  const [existing] = await db
    .select()
    .from(offers)
    .where(and(eq(offers.source, offer.source), eq(offers.sourceOfferKey, offer.sourceOfferKey)));

  if (!existing) {
    // v1 invariant: a single sequential scan process ingests offers one at a
    // time, so the select-then-branch above is not actually racy in practice.
    // The try/catch below guards it anyway, in case a future caller runs
    // concurrent scans (e.g. parallel source scrapers) against the same DB:
    // if another writer inserts the same (source, sourceOfferKey) between our
    // select and our insert, the unique index rejects our insert here instead
    // of silently corrupting data — we detect that and fall through to the
    // same update path as if `existing` had been found originally.
    try {
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
          matchKey: computeMatchKey(offer),
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
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }

      const [raceWinner] = await db
        .select()
        .from(offers)
        .where(and(eq(offers.source, offer.source), eq(offers.sourceOfferKey, offer.sourceOfferKey)));

      if (!raceWinner) {
        // Constraint violation but the row is gone by the time we re-select
        // (shouldn't happen in practice) — surface the original error.
        throw err;
      }

      return ingestExistingOffer(db, raceWinner.id, offer, now);
    }
  }

  return ingestExistingOffer(db, existing.id, offer, now);
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
