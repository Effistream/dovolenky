import { describe, it, expect } from 'vitest';
import {
  buildChart,
  buildFacts,
  buildVerdict,
  offerCtaLabel,
  sourceAttemptTitle,
  sourceDisplayName,
  sourceHealth,
  FRESH_MS,
  STALE_MS,
  SOURCE_NAMES,
} from './history.js';
import { formatCzk, formatNumber } from './format.js';
import type { HistoryResponse, Offer, SourceStatus } from './types.js';

// formatCzk/formatNumber group thousands with a non-breaking space and put one
// before "Kč" too. Compose expected strings from the same formatters so NBSP
// placement matches production exactly (spaces around "%" and prose stay
// regular — only the number/currency tokens carry NBSP).
const n = (x: number): string => formatNumber(x);
const czk = (x: number): string => formatCzk(x);

// --- factories --------------------------------------------------------------

function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: 1,
    source: 'exim',
    title: 'Hotel',
    country: 'Řecko',
    locality: 'Kréta',
    stars: 4,
    board: 'AI',
    transport: 'flight',
    departureAirport: 'PRG',
    departureDate: '2026-08-15',
    nights: 7,
    pricePerPerson: 16490,
    priceTotal: 32980,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    tourOperator: null,
    url: 'https://x/1',
    realPct: null,
    reference: null,
    baseline: null,
    fake: false,
    alternatives: [],
    sparkline: [],
    ...over,
  };
}

/** A series of `n` daily points ending today, at a constant price. */
function series(prices: number[], startIso = '2026-06-05T09:00:00.000Z') {
  const start = new Date(startIso).getTime();
  const DAY = 24 * 60 * 60 * 1000;
  return prices.map((price, i) => ({
    at: new Date(start + i * DAY).toISOString(),
    price,
  }));
}

function history(over: Partial<HistoryResponse> = {}): HistoryResponse {
  return {
    offerId: 1,
    title: 'Hotel',
    series: series([19400, 19100, 19700, 16490]),
    median: 19400,
    claimedOriginalPrice: null,
    ...over,
  };
}

// --- sourceDisplayName ------------------------------------------------------

describe('sourceDisplayName', () => {
  it('title-cases known source slugs for prose (Exim, not EXIM)', () => {
    expect(sourceDisplayName('eximtours')).toBe('Exim');
    expect(sourceDisplayName('invia')).toBe('Invia');
    expect(sourceDisplayName('bluestyle')).toBe('Blue Style');
    // exotic-batch sources (2026-07-07): explicit names, not the title-case fallback
    expect(sourceDisplayName('esotravel')).toBe('ESO travel');
    expect(sourceDisplayName('firo')).toBe('FIRO Travel');
  });
  it('falls back to a capitalised slug for unknown sources', () => {
    expect(sourceDisplayName('foo')).toBe('Foo');
  });
});

// --- offerCtaLabel -----------------------------------------------------------

describe('offerCtaLabel', () => {
  it('gives every source its correct Czech genitive/locative CTA phrasing', () => {
    expect(offerCtaLabel('eximtours')).toBe('Otevřít u Eximu');
    expect(offerCtaLabel('fischer')).toBe('Otevřít u Fischera');
    expect(offerCtaLabel('cedok')).toBe('Otevřít u Čedoku');
    expect(offerCtaLabel('invia')).toBe('Otevřít na Invii');
    expect(offerCtaLabel('etravel')).toBe('Otevřít na eTravelu');
    expect(offerCtaLabel('bluestyle')).toBe('Otevřít u Blue Style');
    expect(offerCtaLabel('zajezdy')).toBe('Otevřít na Zajezdy.cz');
    expect(offerCtaLabel('dovolena')).toBe('Otevřít na Dovolena.cz');
    expect(offerCtaLabel('skrz')).toBe('Otevřít na Skrz.cz');
    expect(offerCtaLabel('dovolenkovani')).toBe('Otevřít na Dovolenkovani.cz');
    // exotic-batch sources (2026-07-07)
    expect(offerCtaLabel('firo')).toBe('Otevřít u FIRO Travel');
    expect(offerCtaLabel('adventura')).toBe('Otevřít u Adventury');
  });

  it('falls back to a generic label for an unknown source', () => {
    expect(offerCtaLabel('foo')).toBe('Otevřít nabídku');
  });
});

// --- registry-slug coverage --------------------------------------------------

// Hardcoded copy of the production source registry (src/sources/index.ts) —
// web/ can't import server code, so this list is kept in sync by hand. If a
// source is added/renamed there, add it here too so this test catches a
// future CTA_LABELS/SOURCE_NAMES drift like the one this test guards against.
const REGISTRY_SLUGS = [
  'cedok',
  'bluestyle',
  'skrz',
  'zajezdy',
  'invia',
  'etravel',
  'fischer',
  'eximtours',
  'dovolena',
  'dovolenkovani',
  'firo',
  'alexandria',
  'deluxea',
  'esotravel',
  'adventura',
  'datour',
] as const;

describe('registry slugs have real copy (no fallback)', () => {
  it.each(REGISTRY_SLUGS)('%s has a non-fallback CTA label', (slug) => {
    expect(offerCtaLabel(slug)).not.toBe('Otevřít nabídku');
  });

  it.each(REGISTRY_SLUGS)('%s has an explicit display name entry', (slug) => {
    // Some slugs (e.g. "skrz") happen to title-case to the same string as
    // their explicit display name, so comparing sourceDisplayName's *output*
    // against the generic fallback can't distinguish "has an entry" from
    // "coincidentally matches the fallback". Assert directly against the
    // hand-written map instead.
    expect(SOURCE_NAMES).toHaveProperty(slug);
  });
});

// --- sourceHealth -------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = new Date('2026-09-03T09:00:00.000Z').getTime();

/** ISO timestamp `ageMs` before NOW_MS. */
const ago = (ageMs: number): string => new Date(NOW_MS - ageMs).toISOString();

function src(over: Partial<SourceStatus> = {}): SourceStatus {
  return {
    source: 'invia',
    status: 'ok',
    startedAt: ago(0),
    finishedAt: ago(0),
    offersFound: 100,
    snapshotsWritten: 100,
    errorCount: 0,
    errorSample: null,
    backoff: false,
    lastOkAt: ago(0),
    lastOkOffers: 100,
    ...over,
  };
}

describe('sourceHealth', () => {
  it('thresholds: 5 h fresh (covers the measured 4.5 h GH cron drift), 24 h stale', () => {
    expect(FRESH_MS).toBe(5 * HOUR_MS);
    expect(STALE_MS).toBe(24 * HOUR_MS);
  });

  it('backoff wins over everything → partial "v pauze"', () => {
    expect(sourceHealth(src({ backoff: true }), NOW_MS)).toEqual({ tone: 'partial', note: 'v pauze' });
    expect(sourceHealth(src({ backoff: true, status: 'failed', lastOkAt: null }), NOW_MS)).toEqual({ tone: 'partial', note: 'v pauze' });
    expect(sourceHealth(src({ backoff: true, lastOkAt: ago(30 * HOUR_MS) }), NOW_MS)).toEqual({ tone: 'partial', note: 'v pauze' });
    // skrz in backoff shows the pause, not the Slevomat note.
    expect(sourceHealth(src({ source: 'skrz', backoff: true }), NOW_MS)).toEqual({ tone: 'partial', note: 'v pauze' });
  });

  it('no usable run in the window → failed "bez dat"', () => {
    expect(sourceHealth(src({ status: 'failed', lastOkAt: null, lastOkOffers: null }), NOW_MS)).toEqual({ tone: 'failed', note: 'bez dat' });
    // An unparseable timestamp is treated the same as none.
    expect(sourceHealth(src({ lastOkAt: 'not-a-date' }), NOW_MS)).toEqual({ tone: 'failed', note: 'bez dat' });
  });

  it('fresh (≤ 5 h) and the latest attempt ok → ok, no note', () => {
    expect(sourceHealth(src({ lastOkAt: ago(0) }), NOW_MS)).toEqual({ tone: 'ok', note: null });
    expect(sourceHealth(src({ lastOkAt: ago(2 * HOUR_MS) }), NOW_MS)).toEqual({ tone: 'ok', note: null });
    // Boundary: exactly 5 h is still fresh.
    expect(sourceHealth(src({ lastOkAt: ago(5 * HOUR_MS) }), NOW_MS)).toEqual({ tone: 'ok', note: null });
  });

  it('fresh data but the latest attempt failed → partial "poslední pokus selhal"', () => {
    // The 2026-09-03 case: Mac ok at 10:40, drifted cloud failed at 10:51.
    const s = src({ status: 'failed', startedAt: ago(9 * 60 * 1000), lastOkAt: ago(20 * 60 * 1000), errorSample: 'fetch exceeded 420000ms budget' });
    expect(sourceHealth(s, NOW_MS)).toEqual({ tone: 'partial', note: 'poslední pokus selhal' });
    expect(sourceHealth(src({ status: 'failed', lastOkAt: ago(5 * HOUR_MS) }), NOW_MS)).toEqual({ tone: 'partial', note: 'poslední pokus selhal' });
  });

  it('fresh data but the latest attempt partial → partial "částečný běh"', () => {
    expect(sourceHealth(src({ status: 'partial', lastOkAt: ago(HOUR_MS) }), NOW_MS)).toEqual({ tone: 'partial', note: 'částečný běh' });
    // Any other non-ok status (e.g. a null status column) reads as a partial run too.
    expect(sourceHealth(src({ status: '', lastOkAt: ago(HOUR_MS) }), NOW_MS)).toEqual({ tone: 'partial', note: 'částečný běh' });
  });

  it('aging (5 h < age ≤ 24 h) → partial "před N h", whole hours, regardless of the latest status', () => {
    expect(sourceHealth(src({ lastOkAt: ago(5 * HOUR_MS + 1) }), NOW_MS)).toEqual({ tone: 'partial', note: 'před 5 h' });
    expect(sourceHealth(src({ lastOkAt: ago(7 * HOUR_MS + 59 * 60 * 1000) }), NOW_MS)).toEqual({ tone: 'partial', note: 'před 7 h' });
    expect(sourceHealth(src({ status: 'failed', lastOkAt: ago(12 * HOUR_MS) }), NOW_MS)).toEqual({ tone: 'partial', note: 'před 12 h' });
    // Boundary: exactly 24 h is still amber.
    expect(sourceHealth(src({ lastOkAt: ago(24 * HOUR_MS) }), NOW_MS)).toEqual({ tone: 'partial', note: 'před 24 h' });
  });

  it('stale (> 24 h) → failed "bez dat N h", whole hours, regardless of the latest status', () => {
    expect(sourceHealth(src({ lastOkAt: ago(24 * HOUR_MS + 1) }), NOW_MS)).toEqual({ tone: 'failed', note: 'bez dat 24 h' });
    expect(sourceHealth(src({ status: 'ok', lastOkAt: ago(30 * HOUR_MS + 30 * 60 * 1000) }), NOW_MS)).toEqual({ tone: 'failed', note: 'bez dat 30 h' });
    expect(sourceHealth(src({ status: 'failed', lastOkAt: ago(72 * HOUR_MS) }), NOW_MS)).toEqual({ tone: 'failed', note: 'bez dat 72 h' });
  });

  it('skrz carries "vč. Slevomatu" only when no other note applies', () => {
    expect(sourceHealth(src({ source: 'skrz' }), NOW_MS)).toEqual({ tone: 'ok', note: 'vč. Slevomatu' });
    expect(sourceHealth(src({ source: 'skrz', lastOkAt: ago(5 * HOUR_MS) }), NOW_MS)).toEqual({ tone: 'ok', note: 'vč. Slevomatu' });
    expect(sourceHealth(src({ source: 'skrz', status: 'failed' }), NOW_MS)).toEqual({ tone: 'partial', note: 'poslední pokus selhal' });
    expect(sourceHealth(src({ source: 'skrz', lastOkAt: ago(7 * HOUR_MS) }), NOW_MS)).toEqual({ tone: 'partial', note: 'před 7 h' });
    expect(sourceHealth(src({ source: 'skrz', lastOkAt: null }), NOW_MS)).toEqual({ tone: 'failed', note: 'bez dat' });
    // Other sources never get it.
    expect(sourceHealth(src({ source: 'invia' }), NOW_MS)).toEqual({ tone: 'ok', note: null });
  });
});

// --- sourceAttemptTitle --------------------------------------------------------

describe('sourceAttemptTitle', () => {
  it('names the latest attempt with its Prague time, status and error sample', () => {
    // 08:51Z = 10:51 Prague in September (CEST).
    const s = src({ status: 'failed', startedAt: '2026-09-03T08:51:00.000Z', errorSample: 'fetch exceeded 420000ms budget' });
    expect(sourceAttemptTitle(s)).toBe('poslední pokus 10:51 · failed · fetch exceeded 420000ms budget');
  });

  it('omits the error sample when there is none', () => {
    const s = src({ status: 'ok', startedAt: '2026-09-03T08:40:00.000Z', errorSample: null });
    expect(sourceAttemptTitle(s)).toBe('poslední pokus 10:40 · ok');
  });
});

// --- buildChart -------------------------------------------------------------

describe('buildChart', () => {
  const VB = { width: 560, height: 190 };

  it('returns null for fewer than two points (can’t draw a line)', () => {
    expect(buildChart({ width: 560, height: 190 }, history({ series: [] }))).toBeNull();
    expect(
      buildChart({ width: 560, height: 190 }, history({ series: series([19400]) })),
    ).toBeNull();
  });

  it('scales the price polyline to the data range and ends at the DNES dot', () => {
    const chart = buildChart(VB, history())!;
    expect(chart).not.toBeNull();
    // One coordinate pair per point.
    const pairs = chart.polylinePoints.trim().split(/\s+/);
    expect(pairs).toHaveLength(4);
    // The dot sits on the last polyline point.
    const [lastX, lastY] = pairs[pairs.length - 1]!.split(',').map(Number);
    expect(chart.dot.x).toBeCloseTo(lastX!, 5);
    expect(chart.dot.y).toBeCloseTo(lastY!, 5);
    // Cheapest price today (16490) → nearest the plot floor (largest y).
    const ys = pairs.map((p) => Number(p.split(',')[1]));
    expect(chart.dot.y).toBe(Math.max(...ys));
    // DNES label carries the current price.
    expect(chart.dot.label).toBe(`DNES ${n(16490)}`);
  });

  it('emits a median band only when a median is present', () => {
    expect(buildChart(VB, history({ median: 19400 }))!.band).not.toBeNull();
    expect(buildChart(VB, history({ median: null }))!.band).toBeNull();
    const band = buildChart(VB, history({ median: 19400 }))!.band!;
    expect(band.label).toContain('PÁSMO MEDIÁNU');
    expect(band.label).toContain(n(19400));
    expect(band.height).toBeGreaterThan(0);
  });

  it('emits the red claimed-original line and copy only when claimedOriginalPrice is set', () => {
    expect(buildChart(VB, history({ claimedOriginalPrice: null }))!.claimedLine).toBeNull();
    const line = buildChart(VB, history({ claimedOriginalPrice: 34300 }))!.claimedLine!;
    expect(line.label).toBe(`„PŮVODNÍ CENA“ ${n(34300)} Kč — ZA TU SE NEPRODÁVALO`);
    // The claimed line sits above (smaller y than) the whole price curve.
    expect(line.y).toBeLessThan(0 + VB.height);
  });

  it('keeps a shared scale when the claimed price is within range (not clamped)', () => {
    // claimed 22000 is well under 1.15× the 19700 data max — shared scale.
    const chart = buildChart(VB, history({ claimedOriginalPrice: 22000 }))!;
    expect(chart.clamped).toBe(false);
    // The claimed line still sits above the whole curve on the shared scale.
    const pairs = chart.polylinePoints.trim().split(/\s+/);
    const ys = pairs.map((p) => Number(p.split(',')[1]));
    expect(chart.claimedLine!.y).toBeLessThan(Math.min(...ys));
  });

  it('clamps a far-outlier claimed price to a fixed top band and rescales the curve to stay legible', () => {
    // Realistic fake case: curve 16490–19700, claimed 34300 (≈1.74× the max) —
    // sharing one scale would squash the curve into ~24px of a 134px plot.
    const h = history({
      series: series([19400, 19100, 19700, 16490]),
      median: 19400,
      claimedOriginalPrice: 34300,
    });
    const chart = buildChart(VB, h)!;
    expect(chart.clamped).toBe(true);

    // The claimed dashed line sits at the fixed top-band y, not scaled with
    // the (much lower) data range.
    expect(chart.claimedLine!.y).toBe(40);

    // The curve now occupies at least half of the plot's total height.
    const pairs = chart.polylinePoints.trim().split(/\s+/);
    const ys = pairs.map((p) => Number(p.split(',')[1]));
    const curveSpan = Math.max(...ys) - Math.min(...ys);
    // The series here isn't flat, so it should actually spread across most of
    // the rescaled plot area, comfortably clearing 50% of the viewBox height.
    expect(curveSpan).toBeGreaterThanOrEqual(VB.height * 0.5 - 40);
    // More directly: the curve's own drawable band (floor − topmost point)
    // covers at least half the viewBox height.
    const floorY = chart.baselineY;
    const topmostY = Math.min(...ys);
    expect(floorY - topmostY).toBeGreaterThanOrEqual(VB.height * 0.5);
  });

  it('in-range claimed price leaves the shared-scale chart unaffected by the clamp logic', () => {
    // Sanity check that adding the clamp branch didn't change the no-claim /
    // in-range-claim geometry from the original shared-scale behaviour.
    const withoutClaim = buildChart(VB, history({ claimedOriginalPrice: null }))!;
    expect(withoutClaim.clamped).toBe(false);
    const pairs = withoutClaim.polylinePoints.trim().split(/\s+/);
    const [, lastY] = pairs[pairs.length - 1]!.split(',').map(Number);
    expect(withoutClaim.dot.y).toBe(lastY);
  });

  it('labels the first and last dates on the axis', () => {
    const chart = buildChart(VB, history())!;
    expect(chart.axis.first).toBe('05.06');
    expect(chart.axis.last).toBe('08.06');
  });
});

// --- buildFacts -------------------------------------------------------------

describe('buildFacts', () => {
  it('counts tracked days and snapshots and reports the 30-day median', () => {
    const facts = buildFacts(history());
    // 4 points spanning 3 days (05.06 → 08.06).
    expect(facts.tracked).toBe('SLEDUJI 3 dny · 4 snapshoty');
    expect(facts.median).toBe(`MEDIÁN 30 DNÍ ${czk(19400)}`);
  });

  it('describes the last move as a drop when the price fell', () => {
    const facts = buildFacts(history({ series: series([19400, 16490]) }));
    // −2 910 Kč proti předchozímu snímku
    expect(facts.lastMove).toContain(`−${czk(2910)}`);
  });

  it('describes the last move as a rise when the price grew', () => {
    const facts = buildFacts(history({ series: series([16490, 19400]) }));
    expect(facts.lastMove).toContain(`+${czk(2910)}`);
  });

  it('reports no movement for a single-point / flat series', () => {
    const facts = buildFacts(history({ series: series([16490]) }));
    expect(facts.lastMove).toBe('BEZ POHYBU zatím jen jeden snímek');
  });

  it('median line reads "zatím bez reference" when no 30-day median', () => {
    const facts = buildFacts(history({ median: null }));
    expect(facts.median).toBe('MEDIÁN 30 DNÍ zatím bez reference');
  });
});

// --- buildVerdict -----------------------------------------------------------

describe('buildVerdict', () => {
  it('collecting: no reference yet → "Sbírám historii, N. den."', () => {
    const h = history({ series: series([19400, 19100]) });
    const v = buildVerdict(offer({ realPct: null, reference: null }), h);
    expect(v).toBe('Sbírám historii, 2. den. Bez reference zatím neřeknu, jestli je sleva reálná.');
  });

  it('fake: names the source, the claimed pct and price, and the "neprodával" line', () => {
    const o = offer({
      source: 'exim',
      fake: true,
      claimedDiscountPct: 52,
      claimedOriginalPrice: 34300,
      realPct: 15,
      reference: 'market',
      baseline: 19400,
      country: 'Řecko',
    });
    const v = buildVerdict(o, history());
    expect(v).toBe(
      `Exim počítá slevu 52 % z ceny ${czk(34300)}. Za tu se termín posledních 30 dní neprodával. Ušetříš 15 % (vs. Řecko).`,
    );
  });

  it('fake without a real saving omits the trailing "ušetříš" clause', () => {
    const o = offer({
      source: 'invia',
      fake: true,
      claimedDiscountPct: 40,
      claimedOriginalPrice: 30000,
      realPct: 0,
      reference: 'market',
      baseline: 19000,
    });
    const v = buildVerdict(o, history());
    expect(v).toBe(
      `Invia počítá slevu 40 % z ceny ${czk(30000)}. Za tu se termín posledních 30 dní neprodával.`,
    );
  });

  it('honest discount: a factual one-liner with the real percentage and baseline', () => {
    const o = offer({
      source: 'invia',
      fake: false,
      realPct: 24,
      reference: 'market',
      baseline: 19700,
      country: 'Řecko',
    });
    const v = buildVerdict(o, history());
    expect(v).toBe(`Reálná sleva 24 % vs. Řecko ${czk(19700)}.`);
  });

  it('honest but price rose → states the rise instead of a discount', () => {
    const o = offer({
      source: 'invia',
      fake: false,
      realPct: -4,
      reference: 'market',
      baseline: 10900,
      country: 'Řecko',
    });
    const v = buildVerdict(o, history());
    expect(v).toBe(`Cena je o 4 % výš (vs. Řecko ${czk(10900)}). Zdražuje.`);
  });

  it('honest discount uses the "hotel" label as "tento hotel"', () => {
    const o = offer({
      source: 'invia',
      fake: false,
      realPct: 12,
      reference: 'hotel',
      baseline: 15000,
    });
    const v = buildVerdict(o, history());
    expect(v).toBe(`Reálná sleva 12 % vs. tento hotel ${czk(15000)}.`);
  });

  it('honest discount uses the offer locality as the "locality" label', () => {
    const o = offer({
      source: 'invia',
      fake: false,
      realPct: 8,
      reference: 'locality',
      baseline: 14700,
      locality: 'Kréta',
    });
    const v = buildVerdict(o, history());
    expect(v).toBe(`Reálná sleva 8 % vs. Kréta ${czk(14700)}.`);
  });
});
