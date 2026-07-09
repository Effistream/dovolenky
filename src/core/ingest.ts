import { and, eq, notInArray, inArray, desc } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import type { Db } from './db/index.js';
import { offers, priceSnapshots } from './db/schema.js';
import type { NormalizedOffer } from './types.js';
import { computeMatchKey, computeHotelKey } from './normalize.js';

const HEARTBEAT_MS = 24 * 60 * 60 * 1000;
const MAX_MISSES = 2;

// Max prepared statements per db.batch() call. libsql runs each batch as one network round-trip
// (and one implicit transaction); we cap the count so a source with thousands of offers is flushed
// in several bounded batches rather than one enormous request. ~100 keeps each round-trip small
// while still collapsing the per-offer write storm (spec: batch ingest for remote-DB scan speed).
const BATCH_CHUNK_SIZE = 100;

// Run `stmts` through chunked db.batch() calls (one round-trip per chunk) and return every
// statement's result, flattened in statement order — so a caller that used `.returning(...)` can map
// results back positionally. libsql's db.batch rejects an empty array and its type demands a
// non-empty tuple, so we only ever call it with a sliced, guaranteed-non-empty chunk.
async function runInBatches(db: Db, stmts: BatchItem<'sqlite'>[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < stmts.length; i += BATCH_CHUNK_SIZE) {
    const chunk = stmts.slice(i, i + BATCH_CHUNK_SIZE);
    const res = await db.batch(chunk as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
    for (const r of res) out.push(r);
  }
  return out;
}

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
  /**
   * The title actually persisted to the offers row (post sticky-name-guard, see
   * ingestExistingOffer below): for a new offer this is offer.title; for an existing offer it's
   * offer.title UNLESS the incoming title is a placeholder and the stored title is real, in which
   * case it's the stored (real) title. Callers that recompute match_key/hotel_key or query the
   * per-night bucket tables at scan time (run.ts#processOffers) MUST build their offer from this
   * persisted title, not the raw incoming offer.title — otherwise their scan-time keys diverge
   * from what's actually stored in the DB (2026-07-07 fix).
   */
  persistedTitle: string;
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
      // Recomputed from offerForMatchKey (which carries nextTitle, the sticky-guarded
      // persisted title) for the exact same reason as matchKey above: a guarded-away
      // placeholder title must not poison the stored hotel_key either (spec §15).
      hotelKey: computeHotelKey(offerForMatchKey),
    })
    .where(eq(offers.id, offerId));

  return { offerId, isNew: false, snapshotWritten: shouldWriteSnapshot, previousPrice, persistedTitle: nextTitle };
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
          hotelKey: computeHotelKey(offer),
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

      return { offerId, isNew: true, snapshotWritten: true, previousPrice: null, persistedTitle: offer.title };
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

/**
 * Batched equivalent of calling {@link ingestOffer} once per offer, for the scan write path
 * (run.ts#processOffers). Produces the SAME offers / price_snapshots DB state as the per-offer loop
 * but in a handful of round-trips per source instead of ~5 per offer — the dominant scan-time cost
 * against a remote (Turso) DB. `ingestOffer` is intentionally left untouched as the reference oracle
 * (the ingest.test.ts suite drives it directly); this function mirrors its rules in memory.
 *
 * Returns one IngestResult per input offer, ALIGNED with input order (offers[i] → result[i]).
 * Incoming offers are deduped by (source, sourceOfferKey) keeping the FIRST occurrence (adapters
 * already dedupe; this is a safety net so a duplicate can't self-collide on the unique index inside
 * a single write batch). Any later duplicate of an already-seen key receives the SAME IngestResult
 * object as its first occurrence, so alignment holds for every index.
 *
 * Semantics replicated from ingestOffer / ingestExistingOffer (kept in lockstep with them):
 *   - NEW (key not currently stored): insert the offer (firstSeenAt = lastSeenAt = now, active,
 *     misses = 0, match_key/hotel_key from the offer) + one snapshot; result isNew = true,
 *     snapshotWritten = true, previousPrice = null, persistedTitle = offer.title.
 *   - EXISTING: write a snapshot iff the price changed vs the latest stored snapshot OR that
 *     snapshot is older than HEARTBEAT_MS; apply the sticky-title guard (an incoming placeholder
 *     title never overwrites a stored real one); refresh the offer row (lastSeenAt = now, active,
 *     misses = 0) with match_key/hotel_key recomputed from the persisted (sticky-guarded) title;
 *     previousPrice = latest snapshot price (or null); persistedTitle = the guarded title.
 *
 * The batch preloads the whole existing-offer set and their latest snapshots up front, so it reads
 * the SAME pre-write state ingestExistingOffer reads per offer (snapshot writes never touch
 * offers.title, and each key is processed once). Write order differs from the per-offer loop —
 * new-offer inserts, then a combined flush of new snapshots + existing updates + existing snapshots
 * — which reassigns price_snapshots.id ordering globally, but every offer's own row + snapshot
 * CONTENT is identical (verified by the batched-vs-per-offer equivalence test in ingest.test.ts).
 *
 * NOTE (deliberately NOT replicated): ingestOffer's unique-constraint race-recovery fallback. The
 * scan is single-process (Task 47: fetch concurrent, PROCESS sequential) and runs are ~2h apart, so
 * nothing races us for the same (source, sourceOfferKey). If that ever changed, a batch insert here
 * would reject on the unique index and fail the whole source (acceptable) rather than corrupt data.
 */
export async function ingestSourceOffers(
  db: Db,
  incoming: NormalizedOffer[],
  now: Date = new Date(),
): Promise<IngestResult[]> {
  if (incoming.length === 0) return [];
  const nowIso = now.toISOString();

  // (source, sourceOfferKey) composite mirrors the DB unique index. In the scan all offers share
  // one source (the adapter), so this reduces to sourceOfferKey; keying on the composite keeps the
  // function correct if a caller ever mixes sources in one call. The NUL separator can't appear in either part, so distinct pairs never collide.
  const compositeKey = (source: string, sourceOfferKey: string): string => `${source}\u0000${sourceOfferKey}`;

  // 1) Dedupe incoming by composite key, keeping the first occurrence. `uniqueIndexForInput[i]` maps
  //    input i to its unique offer so duplicates share the first occurrence's result on the way out.
  const uniqueOffers: NormalizedOffer[] = [];
  const uniqueIndexByKey = new Map<string, number>();
  const uniqueIndexForInput: number[] = [];
  for (const offer of incoming) {
    const key = compositeKey(offer.source, offer.sourceOfferKey);
    let idx = uniqueIndexByKey.get(key);
    if (idx === undefined) {
      idx = uniqueOffers.length;
      uniqueIndexByKey.set(key, idx);
      uniqueOffers.push(offer);
    }
    uniqueIndexForInput.push(idx);
  }

  // 2) Preload every currently-stored offer for the distinct sources present (one query), keyed by
  //    composite key — the batch equivalent of ingestOffer's per-offer "select existing" branch.
  const distinctSources = [...new Set(uniqueOffers.map((o) => o.source))];
  const existingRows = await db.select().from(offers).where(inArray(offers.source, distinctSources));
  const existingByKey = new Map<string, (typeof existingRows)[number]>();
  for (const row of existingRows) {
    existingByKey.set(compositeKey(row.source, row.sourceOfferKey), row);
  }

  // 3) Preload the latest snapshot (max id) per existing offer we're about to re-ingest (one query),
  //    for previousPrice + the priceChanged / snapshotStale decision — the batch equivalent of
  //    ingestExistingOffer's "select latest snapshot" per offer.
  const existingIds = uniqueOffers
    .map((o) => existingByKey.get(compositeKey(o.source, o.sourceOfferKey)))
    .filter((r): r is (typeof existingRows)[number] => r !== undefined)
    .map((r) => r.id);
  const latestSnapshotByOfferId = new Map<number, { pricePerPerson: number; capturedAt: string }>();
  if (existingIds.length > 0) {
    const snaps = await db
      .select({
        id: priceSnapshots.id,
        offerId: priceSnapshots.offerId,
        pricePerPerson: priceSnapshots.pricePerPerson,
        capturedAt: priceSnapshots.capturedAt,
      })
      .from(priceSnapshots)
      .where(inArray(priceSnapshots.offerId, existingIds));
    const maxIdByOfferId = new Map<number, number>();
    for (const snap of snaps) {
      const prevMax = maxIdByOfferId.get(snap.offerId);
      if (prevMax === undefined || snap.id > prevMax) {
        maxIdByOfferId.set(snap.offerId, snap.id);
        latestSnapshotByOfferId.set(snap.offerId, {
          pricePerPerson: snap.pricePerPerson,
          capturedAt: snap.capturedAt,
        });
      }
    }
  }

  const results: IngestResult[] = new Array(uniqueOffers.length);

  // New offers: remember their slot in `results` (filled once the insert returns an id) and build
  // their inserts in first-occurrence order, so offers.id is assigned in the same order the
  // per-offer loop would assign it.
  const newResultIdx: number[] = [];
  const newOffersInOrder: NormalizedOffer[] = [];
  const newInsertStmts: BatchItem<'sqlite'>[] = [];

  // Writes that don't need a freshly-inserted id: existing-offer updates + existing-offer snapshots.
  const updateStmts: BatchItem<'sqlite'>[] = [];
  const existingSnapshotStmts: BatchItem<'sqlite'>[] = [];

  for (let i = 0; i < uniqueOffers.length; i += 1) {
    const offer = uniqueOffers[i]!;
    const existing = existingByKey.get(compositeKey(offer.source, offer.sourceOfferKey));

    if (!existing) {
      newResultIdx.push(i);
      newOffersInOrder.push(offer);
      newInsertStmts.push(
        db
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
            hotelKey: computeHotelKey(offer),
          })
          .returning({ id: offers.id }),
      );
      continue;
    }

    // EXISTING — mirror ingestExistingOffer exactly.
    const latest = latestSnapshotByOfferId.get(existing.id);
    const previousPrice = latest ? latest.pricePerPerson : null;
    const priceChanged = latest ? latest.pricePerPerson !== offer.pricePerPerson : true;
    const snapshotStale = latest
      ? now.getTime() - new Date(latest.capturedAt).getTime() > HEARTBEAT_MS
      : true;
    const shouldWriteSnapshot = priceChanged || snapshotStale;

    // Sticky-name guard: never let a placeholder title overwrite a stored real one. `existing.title`
    // is the same row ingestExistingOffer re-reads (its snapshot insert never touches offers.title).
    const incomingIsPlaceholder = isPlaceholderTitle(offer.title);
    const existingIsReal = !isPlaceholderTitle(existing.title);
    const nextTitle = incomingIsPlaceholder && existingIsReal ? existing.title : offer.title;
    // Recompute match_key/hotel_key from the persisted (nextTitle) offer, not the raw incoming one,
    // so a guarded-away placeholder can't poison the stored keys (mirrors ingestExistingOffer).
    const offerForMatchKey = nextTitle === offer.title ? offer : { ...offer, title: nextTitle };

    if (shouldWriteSnapshot) {
      existingSnapshotStmts.push(
        db.insert(priceSnapshots).values({
          offerId: existing.id,
          capturedAt: nowIso,
          pricePerPerson: offer.pricePerPerson,
          priceTotal: offer.priceTotal,
          claimedOriginalPrice: offer.claimedOriginalPrice,
          claimedDiscountPct: offer.claimedDiscountPct,
          omnibusLowestPrice: offer.omnibusLowestPrice,
        }),
      );
    }

    updateStmts.push(
      db
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
          hotelKey: computeHotelKey(offerForMatchKey),
        })
        .where(eq(offers.id, existing.id)),
    );

    results[i] = {
      offerId: existing.id,
      isNew: false,
      snapshotWritten: shouldWriteSnapshot,
      previousPrice,
      persistedTitle: nextTitle,
    };
  }

  // 4) Phase A: insert the new offers (chunked, 1 round-trip each), read back their assigned ids in
  //    statement order, then fill their results and build their snapshot inserts.
  const newSnapshotStmts: BatchItem<'sqlite'>[] = [];
  if (newInsertStmts.length > 0) {
    const insertResults = await runInBatches(db, newInsertStmts);
    for (let k = 0; k < newResultIdx.length; k += 1) {
      const offer = newOffersInOrder[k]!;
      const returned = insertResults[k] as Array<{ id: number }>;
      const offerId = returned[0]!.id;
      results[newResultIdx[k]!] = {
        offerId,
        isNew: true,
        snapshotWritten: true,
        previousPrice: null,
        persistedTitle: offer.title,
      };
      newSnapshotStmts.push(
        db.insert(priceSnapshots).values({
          offerId,
          capturedAt: nowIso,
          pricePerPerson: offer.pricePerPerson,
          priceTotal: offer.priceTotal,
          claimedOriginalPrice: offer.claimedOriginalPrice,
          claimedDiscountPct: offer.claimedDiscountPct,
          omnibusLowestPrice: offer.omnibusLowestPrice,
        }),
      );
    }
  }

  // 5) Phase B: flush all remaining writes together (new snapshots + existing updates + existing
  //    snapshots). None depend on another's result now that the new ids are known, so they share one
  //    chunked flush.
  const phaseB: BatchItem<'sqlite'>[] = [...newSnapshotStmts, ...updateStmts, ...existingSnapshotStmts];
  if (phaseB.length > 0) {
    await runInBatches(db, phaseB);
  }

  // 6) Expand unique results back to input alignment; duplicates share their first occurrence.
  return uniqueIndexForInput.map((idx) => results[idx]!);
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

  // Behaviorally identical to the former per-row UPDATE loop — each row's misses is incremented and
  // it deactivates at MAX_MISSES from ITS OWN prior misses/active — but sent as chunked db.batch()
  // round-trips instead of one UPDATE per row (each statement is keyed by a distinct offers.id, so
  // batch order is irrelevant). Guarded for empty (runInBatches never calls db.batch with []).
  const updates: BatchItem<'sqlite'>[] = missed.map((row) => {
    const nextMisses = row.misses + 1;
    return db
      .update(offers)
      .set({
        misses: nextMisses,
        active: nextMisses >= MAX_MISSES ? false : row.active,
      })
      .where(eq(offers.id, row.id));
  });

  if (updates.length > 0) {
    await runInBatches(db, updates);
  }
}
