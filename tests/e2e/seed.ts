/**
 * E2E seed (Task 28): builds a THROWAWAY SQLite file and fills it with
 * deterministic fixture data via the *real* production pipeline
 * (openDb → ensureSchema → ingestOffer), so the seeded rows carry the exact
 * match_key / snapshot / discount semantics the Terminál renders in production.
 *
 * Determinism vs. the 30-day windows: the API computes real discounts and the
 * history median relative to `now` at *request* time (real wall clock). So every
 * snapshot date here is anchored to `new Date()` captured once at seed start
 * (BASE), never a hardcoded absolute — an offer whose history is "20 days ago"
 * stays 20 days ago no matter when the suite runs. Prices/titles/sources ARE
 * fixed, so the DOM assertions are stable.
 *
 * Run standalone (Playwright's webServer does this): DATABASE_URL=file:<tmp>
 * tsx tests/e2e/seed.ts
 *
 * What it seeds (all requirements of the brief):
 *  - 13 active offers across 3 fake sources (invia / fischer / exim).
 *  - one cross-source pair (same match_key) → the pricier peer shows as "Také:".
 *  - one fake-discount offer with 7 snapshots of own history (own reference
 *    kicks in → realPct modest, claimed pct huge → `fake` flag) + a claimed
 *    original price (the red „PŮVODNÍ CENA“ line in the detail chart).
 *  - one offer with a claimed original but honest pricing.
 *  - one single-snapshot offer → detail shows „zatím málo dat na graf“.
 *  - mixed countries (Řecko/Turecko/Egypt/Španělsko/Bulharsko) & profiles.
 *  - source_runs: ok, partial, and a failed+BLOCKED row (→ backoff / red).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, ensureSchema, type Db } from '../../src/core/db/index.js';
import { sourceRuns } from '../../src/core/db/schema.js';
import { ingestOffer } from '../../src/core/ingest.js';
import type { NormalizedOffer } from '../../src/core/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Anchor: all seed timestamps are offsets from this single capture of "now". */
const BASE = new Date();

/** `days` before BASE, at noon UTC (well clear of the Prague day boundary). */
function daysAgo(days: number): Date {
  const d = new Date(BASE.getTime() - days * DAY_MS);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

function makeOffer(overrides: Partial<NormalizedOffer>): NormalizedOffer {
  return {
    source: 'invia',
    sourceOfferKey: 'offer-key',
    title: 'Hotel Bez Názvu',
    country: 'Řecko',
    locality: null,
    stars: 4,
    board: 'AI',
    transport: 'flight',
    departureAirport: 'PRG',
    departureDate: '2026-08-15',
    nights: 7,
    pricePerPerson: 15000,
    priceTotal: 30000,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    omnibusLowestPrice: null,
    tourOperator: 'SeedTours',
    url: 'https://example.test/offer',
    ...overrides,
  };
}

async function seed(db: Db): Promise<void> {
  // -----------------------------------------------------------------------
  // 1) The fake-discount hero offer with a long own-history.
  // Ingest at -22/-18/-14/-10/-6/-2 days (each >24h apart and a different
  // price, so every ingest writes a fresh snapshot per the heartbeat rules),
  // then a final "today" snapshot at the low current price. Seven snapshots
  // total, spanning 22 days → own reference (≥3 snaps, ≥5-day span) engages.
  // Claimed original 34 900 with a claimed 45 % is far above the real saving
  // off the own-median → the `fake` flag lights up.
  // -----------------------------------------------------------------------
  const fakeKey = 'invia:fake-hero-2026-08-15';
  const fakeHistory: { day: number; price: number }[] = [
    { day: 22, price: 22900 },
    { day: 18, price: 22400 },
    { day: 14, price: 21900 },
    { day: 10, price: 21500 },
    { day: 6, price: 20900 },
    { day: 2, price: 20500 },
  ];
  for (const point of fakeHistory) {
    await ingestOffer(
      db,
      makeOffer({
        source: 'invia',
        sourceOfferKey: fakeKey,
        title: 'Hotel Poseidon Beach',
        locality: 'Kréta',
        country: 'Řecko',
        stars: 4,
        pricePerPerson: point.price,
        priceTotal: point.price * 2,
        claimedOriginalPrice: 34900,
        claimedDiscountPct: 45,
        url: 'https://invia.test/poseidon',
      }),
      daysAgo(point.day),
    );
  }
  // Today's snapshot: the current low price. Different price → snapshot written.
  await ingestOffer(
    db,
    makeOffer({
      source: 'invia',
      sourceOfferKey: fakeKey,
      title: 'Hotel Poseidon Beach',
      locality: 'Kréta',
      country: 'Řecko',
      stars: 4,
      pricePerPerson: 19200,
      priceTotal: 38400,
      claimedOriginalPrice: 34900,
      claimedDiscountPct: 45,
      url: 'https://invia.test/poseidon',
    }),
    BASE,
  );

  // -----------------------------------------------------------------------
  // 2) Cross-source pair: identical match_key inputs (title/country/date/
  // nights/board/airport), two different sources & prices. The cheaper one
  // (fischer) becomes the representative; the pricier (invia) shows up as a
  // "Také:" alternative on that row.
  // -----------------------------------------------------------------------
  const twinFields = {
    title: 'Hotel Blue Lagoon',
    country: 'Turecko',
    locality: 'Side',
    stars: 5,
    board: 'AI' as const,
    departureAirport: 'PRG',
    departureDate: '2026-07-20',
    nights: 7,
  };
  await ingestOffer(
    db,
    makeOffer({
      ...twinFields,
      source: 'fischer',
      sourceOfferKey: 'fischer:blue-lagoon-2026-07-20',
      pricePerPerson: 18400,
      priceTotal: 36800,
      url: 'https://fischer.test/blue-lagoon',
    }),
    BASE,
  );
  await ingestOffer(
    db,
    makeOffer({
      ...twinFields,
      source: 'invia',
      sourceOfferKey: 'invia:blue-lagoon-2026-07-20',
      pricePerPerson: 19900,
      priceTotal: 39800,
      url: 'https://invia.test/blue-lagoon',
    }),
    BASE,
  );

  // -----------------------------------------------------------------------
  // 3) Honest offer WITH a claimed original (has the red „PŮVODNÍ CENA“ data
  // but is not flagged fake — claimed pct ≈ real). Single snapshot is fine;
  // reference stays null so it reads as "collecting", which is realistic.
  // -----------------------------------------------------------------------
  await ingestOffer(
    db,
    makeOffer({
      source: 'exim',
      sourceOfferKey: 'exim:sunrise-2026-09-05',
      title: 'Hotel Sunrise Garden',
      country: 'Egypt',
      locality: 'Hurghada',
      stars: 4,
      pricePerPerson: 16800,
      priceTotal: 33600,
      claimedOriginalPrice: 19900,
      claimedDiscountPct: 15,
      departureDate: '2026-09-05',
      url: 'https://exim.test/sunrise',
    }),
    BASE,
  );

  // -----------------------------------------------------------------------
  // 4) Single-snapshot offer → detail shows „zatím málo dat na graf“.
  // -----------------------------------------------------------------------
  await ingestOffer(
    db,
    makeOffer({
      source: 'fischer',
      sourceOfferKey: 'fischer:fresh-2026-08-30',
      title: 'Hotel Costa Nueva',
      country: 'Španělsko',
      locality: 'Mallorca',
      stars: 3,
      pricePerPerson: 13900,
      priceTotal: 27800,
      departureDate: '2026-08-30',
      url: 'https://fischer.test/costa-nueva',
    }),
    BASE,
  );

  // -----------------------------------------------------------------------
  // 5) Filler offers → ≥12 active offers, mixed countries & profiles. Distinct
  // titles → distinct match_keys, so each is its own board row. A spread of
  // countries gives the country chips several options; a couple in Řecko/
  // Turecko/AI/flight match the leto-more profile, and one is within 14 days of
  // BASE so it matches last-minute.
  // -----------------------------------------------------------------------
  const soonIso = new Date(BASE.getTime() + 5 * DAY_MS).toISOString().slice(0, 10);
  const fillers: Partial<NormalizedOffer>[] = [
    { source: 'invia', sourceOfferKey: 'invia:kos-1', title: 'Hotel Aegean Star', country: 'Řecko', locality: 'Kos', stars: 4, pricePerPerson: 17200, departureDate: '2026-08-10' },
    { source: 'exim', sourceOfferKey: 'exim:antalya-1', title: 'Hotel Lara Palace', country: 'Turecko', locality: 'Antalya', stars: 5, pricePerPerson: 21400, departureDate: '2026-07-28' },
    { source: 'fischer', sourceOfferKey: 'fischer:djerba-1', title: 'Hotel Palm Oasis', country: 'Tunisko', locality: 'Djerba', stars: 4, board: 'HB', pricePerPerson: 14200, departureDate: '2026-09-12' },
    { source: 'invia', sourceOfferKey: 'invia:sunny-1', title: 'Hotel Sunny Bay', country: 'Bulharsko', locality: 'Slunečné pobřeží', stars: 3, board: 'HB', pricePerPerson: 9900, departureDate: '2026-08-22' },
    { source: 'exim', sourceOfferKey: 'exim:costa-1', title: 'Hotel Costa Verde', country: 'Španělsko', locality: 'Costa Brava', stars: 4, pricePerPerson: 15600, departureDate: '2026-08-18' },
    { source: 'fischer', sourceOfferKey: 'fischer:rhodes-1', title: 'Hotel Rhodos Bay', country: 'Řecko', locality: 'Rhodos', stars: 4, pricePerPerson: 18100, departureDate: '2026-09-01' },
    { source: 'invia', sourceOfferKey: 'invia:lastminute-1', title: 'Hotel Marmaris Deal', country: 'Turecko', locality: 'Marmaris', stars: 4, pricePerPerson: 12400, departureDate: soonIso },
  ];
  for (const f of fillers) {
    await ingestOffer(db, makeOffer({ ...f, url: `https://example.test/${f.sourceOfferKey}` }), BASE);
  }

  // -----------------------------------------------------------------------
  // 6) source_runs: one healthy (ok), one empty-but-benign (partial), and one
  // blocked failure whose BLOCKED: error_sample is within the last 24h → the
  // API's buildSources marks it `backoff`, and the ZDROJE card renders it red /
  // "v pauze". Start times are anchored to BASE so they read as "today".
  // -----------------------------------------------------------------------
  const okStart = new Date(BASE.getTime() - 30 * 60 * 1000); // 30 min ago
  const okFinish = new Date(BASE.getTime() - 29 * 60 * 1000);
  await db.insert(sourceRuns).values({
    source: 'invia',
    startedAt: okStart.toISOString(),
    finishedAt: okFinish.toISOString(),
    offersFound: 9,
    snapshotsWritten: 9,
    errorCount: 0,
    status: 'ok',
    errorSample: null,
  });

  await db.insert(sourceRuns).values({
    source: 'fischer',
    startedAt: okStart.toISOString(),
    finishedAt: okFinish.toISOString(),
    offersFound: 3,
    snapshotsWritten: 3,
    errorCount: 0,
    status: 'ok',
    errorSample: null,
  });

  await db.insert(sourceRuns).values({
    source: 'exim',
    startedAt: okStart.toISOString(),
    finishedAt: okFinish.toISOString(),
    offersFound: 0,
    snapshotsWritten: 0,
    errorCount: 0,
    status: 'partial',
    errorSample: null,
  });

  // Blocked ~2h ago → still inside the 24h backoff window.
  const blockedStart = new Date(BASE.getTime() - 2 * 60 * 60 * 1000);
  await db.insert(sourceRuns).values({
    source: 'skrz',
    startedAt: blockedStart.toISOString(),
    finishedAt: blockedStart.toISOString(),
    offersFound: null,
    snapshotsWritten: null,
    errorCount: 1,
    status: 'failed',
    errorSample: 'BLOCKED: HTTP 403 (Cloudflare managed challenge)',
  });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('seed: DATABASE_URL must be set (expected a throwaway file: URL)');
  }
  // libsql can't create the DB file in a directory that doesn't exist yet
  // (SQLITE_CANTOPEN / error 14). The playwright.config points the seed at
  // test-results/, which may not exist on a clean checkout — create it first.
  const filePath = url.startsWith('file:') ? url.slice('file:'.length) : null;
  if (filePath && filePath !== ':memory:' && !filePath.startsWith(':')) {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const db = openDb(url);
  await ensureSchema(db);
  await seed(db);
  // eslint-disable-next-line no-console
  console.log(`e2e seed complete → ${url}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
