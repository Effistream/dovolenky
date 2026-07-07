/**
 * Pure, DOM-free model builders for the offer detail (Task 27): the SVG price
 * chart, the facts kv block, and the verdict sentence. Every function here is
 * unit-tested (history.test.ts) and side-effect free so the tests run under node
 * with no DOM. Copy follows design-system/MASTER.md (Czech, concrete numbers,
 * active voice, no exclamations, fake-slevy verdict names the actor).
 */
import type { HistoryResponse, Offer } from './types.js';
import { formatCzk, formatNumber, referenceLabel } from './format.js';
import { formatDayMonth } from './term.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Source display names — title-case for prose ("Exim počítá…"), distinct from
// term.ts#sourceLabel which uppercases for the board's mono ZDROJ cell. Keyed
// on the production registry slugs (src/sources/index.ts): cedok, bluestyle,
// skrz, zajezdy, invia, etravel, fischer, eximtours, dovolena, dovolenkovani.
// ---------------------------------------------------------------------------
export const SOURCE_NAMES: Record<string, string> = {
  invia: 'Invia',
  fischer: 'Fischer',
  eximtours: 'Exim',
  cedok: 'Čedok',
  bluestyle: 'Blue Style',
  zajezdy: 'Zajezdy.cz',
  dovolena: 'Dovolena.cz',
  dovolenkovani: 'Dovolenkovani.cz',
  etravel: 'eTravel',
  skrz: 'Skrz',
};

/** "exim" → "Exim" for prose. Unknown slugs get a capitalised first letter. */
export function sourceDisplayName(source: string): string {
  const known = SOURCE_NAMES[source];
  if (known) return known;
  if (source.length === 0) return source;
  return source.charAt(0).toUpperCase() + source.slice(1);
}

// ---------------------------------------------------------------------------
// CTA label (per-source genitive phrasing)
// ---------------------------------------------------------------------------

/**
 * Explicit per-source CTA copy — Czech genitive/locative phrasing doesn't
 * follow from the slug mechanically ("Otevřít u Exim" is wrong; it must be
 * "Otevřít u Eximu"), so each source gets an exact, hand-written label rather
 * than a templated "Otevřít u {name}". MASTER.md's canonical example is
 * "Otevřít u Eximu". Keyed on the production registry slugs (see SOURCE_NAMES
 * above for the source-of-truth list).
 */
const CTA_LABELS: Record<string, string> = {
  eximtours: 'Otevřít u Eximu',
  fischer: 'Otevřít u Fischera',
  cedok: 'Otevřít u Čedoku',
  invia: 'Otevřít na Invii',
  etravel: 'Otevřít na eTravelu',
  bluestyle: 'Otevřít u Blue Style',
  zajezdy: 'Otevřít na Zajezdy.cz',
  dovolena: 'Otevřít na Dovolena.cz',
  skrz: 'Otevřít na Skrz.cz',
  dovolenkovani: 'Otevřít na Dovolenkovani.cz',
};

/** The primary CTA label for a source, with correct Czech grammar. */
export function offerCtaLabel(source: string): string {
  return CTA_LABELS[source] ?? 'Otevřít nabídku';
}

// ---------------------------------------------------------------------------
// Source status dot (ZDROJE card)
// ---------------------------------------------------------------------------

/** Dot colour for a source: 'ok' green, 'partial' amber (incl. backoff), 'failed' red. */
export type SourceDotTone = 'ok' | 'partial' | 'failed';

/**
 * Maps a source run's status + backoff flag to a dot tone (MASTER.md: green ok /
 * amber partial-or-backoff / red failed). A source in backoff is amber even if
 * its latest completed run was 'ok', because the scanner is currently pausing it.
 */
export function sourceDotTone(status: string, backoff: boolean): SourceDotTone {
  if (status === 'failed') return 'failed';
  if (backoff || status === 'partial') return 'partial';
  return 'ok';
}

/** Via-note shown next to a source name in the ZDROJE card, or null. */
export function sourceViaNote(source: string, backoff: boolean): string | null {
  if (backoff) return 'v pauze';
  if (source === 'skrz') return 'vč. Slevomatu';
  return null;
}

/** Czech plural for "den": 1 den, 2–4 dny, 5+ dní. */
function daysLabel(days: number): string {
  if (days === 1) return '1 den';
  if (days >= 2 && days <= 4) return `${days} dny`;
  return `${days} dní`;
}

/** Czech plural for "snapshot": 1 snapshot, 2–4 snapshoty, 5+ snapshotů. */
function snapshotsLabel(n: number): string {
  if (n === 1) return '1 snapshot';
  if (n >= 2 && n <= 4) return `${n} snapshoty`;
  return `${n} snapshotů`;
}

/** Whole days spanned by the series (first → last capture), min 0. */
function trackedDays(series: HistoryResponse['series']): number {
  if (series.length < 2) return 0;
  const first = new Date(series[0]!.at).getTime();
  const last = new Date(series[series.length - 1]!.at).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return Math.max(0, Math.round((last - first) / DAY_MS));
}

// ---------------------------------------------------------------------------
// Chart model
// ---------------------------------------------------------------------------

export interface ChartViewBox {
  width: number;
  height: number;
}

export interface ChartModel {
  /** "x,y x,y …" for the white price <polyline>. */
  polylinePoints: string;
  /** The green DNES endpoint dot + its label (current price). */
  dot: { x: number; y: number; label: string };
  /** Amber median band rect, or null when no 30-day median. */
  band: { y: number; height: number; label: string } | null;
  /** Red dashed claimed-original line + copy, or null when not claimed. */
  claimedLine: { y: number; label: string } | null;
  /** First/last date labels for the x-axis. */
  axis: { first: string; last: string };
  /** The baseline rule y (plot floor). */
  baselineY: number;
  /**
   * True when claimedOriginalPrice sat far enough above the price series that
   * the claimed line was pinned to a fixed top band instead of sharing the
   * price curve's scale (see buildChart doc comment). The component doesn't
   * currently vary rendering on this, but it's exposed so callers can key off
   * "this chart is in outlier-clamp mode" without recomputing the ratio.
   */
  clamped: boolean;
}

// Inner plot padding: leaves room for the top claimed-line label and the bottom
// axis-date labels so nothing drawn ever collides with the viewBox edges.
const PLOT_TOP = 34;
const PLOT_BOTTOM_PAD = 22;
const BAND_HEIGHT = 18;

// When claimedOriginalPrice exceeds the price-series/median range by more than
// this factor, sharing one linear scale between it and the curve squashes the
// curve into a sliver near the floor (the whole point of the chart). Past this
// ratio we stop scaling the claimed line with the data and instead pin it to a
// fixed row near the top, then rescale the curve + band alone into the space
// below it.
const CLAMP_RATIO = 1.15;
// Fixed y for the claimed dashed line once clamped (mirrors the mockup's
// in-range example, where the line sits near the top of the plot).
const CLAMPED_CLAIMED_Y = 40;
// Padding between the clamped claimed-line row and the rescaled curve/band
// plot area below it, so the two never visually merge.
const CLAMPED_TOP_GAP = 24;

/**
 * Scales an offer's price history into an SVG-ready model within `viewBox`.
 * Returns null for a degenerate series (<2 points) — the caller shows a
 * "zatím málo dat na graf" note instead of a chart.
 *
 * Normally the vertical scale spans every value we draw (all series prices,
 * the median band, and the claimed-original line) so the claimed line sits
 * visibly above the curve and the band overlaps it, matching the mockup.
 * Higher price = smaller y (top), like the sparkline.
 *
 * But a "fake sleva" claimed price is often wildly above the real range (the
 * whole point of the flag) — sharing one scale then squeezes the actual price
 * curve into a sliver at the bottom, which defeats the chart. When
 * claimedOriginalPrice exceeds 1.15× the max of the price series + median
 * band, we pin the claimed line to a fixed row near the top (CLAMPED_CLAIMED_Y)
 * and scale only the curve + band into the remaining plot area below it, so
 * the curve stays legible. `clamped` on the result flags when this happened.
 */
export function buildChart(
  viewBox: ChartViewBox,
  history: HistoryResponse,
): ChartModel | null {
  const { series, median, claimedOriginalPrice } = history;
  if (series.length < 2) return null;

  const prices = series.map((p) => p.price);
  const floorY = viewBox.height - PLOT_BOTTOM_PAD;

  // The curve's own range (price series + median), independent of the claim.
  const dataValues = [...prices];
  if (median != null) dataValues.push(median);
  const dataMax = Math.max(...dataValues);

  const clamped =
    claimedOriginalPrice != null && claimedOriginalPrice > dataMax * CLAMP_RATIO;

  // Value range for the curve/band scale: normally includes the claimed price
  // too (one shared scale); when clamped, the claimed price is excluded so the
  // curve gets the full plot height to itself.
  const values = [...dataValues];
  if (claimedOriginalPrice != null && !clamped) values.push(claimedOriginalPrice);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  // Plot area for the curve/band: the full inner height normally, or the band
  // below the fixed claimed-line row when clamped.
  const plotTop = clamped ? CLAMPED_CLAIMED_Y + CLAMPED_TOP_GAP : PLOT_TOP;
  const innerH = floorY - plotTop;

  const x = (i: number): number =>
    (i / (series.length - 1)) * viewBox.width;
  // Higher value → smaller y (nearer plotTop). Flat range → mid plot.
  const y = (value: number): number =>
    span === 0 ? plotTop + innerH / 2 : plotTop + (1 - (value - min) / span) * innerH;

  const coords = series.map((p, i) => ({ px: round(x(i)), py: round(y(p.price)) }));
  const polylinePoints = coords.map((c) => `${c.px},${c.py}`).join(' ');
  const last = coords[coords.length - 1]!;

  const currentPrice = prices[prices.length - 1]!;
  const dot = { x: last.px, y: last.py, label: `DNES ${formatNumber(currentPrice)}` };

  const band =
    median != null
      ? {
          y: round(y(median) - BAND_HEIGHT / 2),
          height: BAND_HEIGHT,
          label: `PÁSMO MEDIÁNU · ${formatNumber(median)} Kč`,
        }
      : null;

  const claimedLine =
    claimedOriginalPrice != null
      ? {
          y: clamped ? CLAMPED_CLAIMED_Y : round(y(claimedOriginalPrice)),
          label: `„PŮVODNÍ CENA“ ${formatNumber(claimedOriginalPrice)} Kč — ZA TU SE NEPRODÁVALO`,
        }
      : null;

  return {
    polylinePoints,
    dot,
    band,
    claimedLine,
    axis: {
      first: formatDayMonth(series[0]!.at),
      last: formatDayMonth(series[series.length - 1]!.at),
    },
    baselineY: floorY,
    clamped,
  };
}

/** Round to 1 decimal so SVG coordinate strings stay compact and deterministic. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Facts kv block
// ---------------------------------------------------------------------------

export interface FactsModel {
  /** "SLEDUJI 26 dní · 31 snapshotů" */
  tracked: string;
  /** "MEDIÁN 30 DNÍ 19 400 Kč" or "… zatím bez reference" */
  median: string;
  /** "POKLES −2 910 Kč proti předchozímu snímku" / "…jen jeden snímek" */
  lastMove: string;
}

/**
 * The three-line facts block from the mockup, derived from real history:
 *  - tracked span + snapshot count,
 *  - 30-day median (or "zatím bez reference"),
 *  - the last price move vs. the previous snapshot.
 *
 * Note: the mockup's third line reads "proti včerejšku" (vs. yesterday), but
 * snapshots aren't guaranteed to be exactly one day apart, so this says
 * "proti předchozímu snímku" (vs. the previous snapshot) instead — an
 * intentional generalisation, not a copy bug.
 */
export function buildFacts(history: HistoryResponse): FactsModel {
  const { series, median } = history;
  const days = trackedDays(series);

  const tracked = `SLEDUJI ${daysLabel(days)} · ${snapshotsLabel(series.length)}`;

  const medianLine =
    median != null
      ? `MEDIÁN 30 DNÍ ${formatCzk(median)}`
      : 'MEDIÁN 30 DNÍ zatím bez reference';

  let lastMove: string;
  if (series.length < 2) {
    lastMove = 'BEZ POHYBU zatím jen jeden snímek';
  } else {
    const prev = series[series.length - 2]!.price;
    const cur = series[series.length - 1]!.price;
    const delta = cur - prev;
    if (delta === 0) {
      lastMove = 'BEZ POHYBU proti předchozímu snímku';
    } else {
      const sign = delta < 0 ? '−' : '+';
      const word = delta < 0 ? 'POKLES' : 'RŮST';
      lastMove = `${word} ${sign}${formatCzk(Math.abs(delta))} proti předchozímu snímku`;
    }
  }

  return { tracked, median: medianLine, lastMove };
}

// ---------------------------------------------------------------------------
// Verdict sentence
// ---------------------------------------------------------------------------

/**
 * The verdict paragraph, built from real discount data per MASTER.md copy rules:
 *  - collecting (reference == null): "Sbírám historii, N. den. …"
 *  - fake (fake == true): names the actor, the claimed pct/price and the
 *    "za tu se neprodával" line, plus a real-saving clause when realPct > 0.
 *  - honest: a factual one-liner (real discount, or a price rise when realPct ≤ 0).
 * The reference tier (own/omnibus/hotel/locality/market) is always named via
 * referenceLabel (spec §15) so the verdict matches the board cell and the
 * Telegram message for the same offer (src/core/format.ts#referenceLabel).
 */
export function buildVerdict(offer: Offer, history: HistoryResponse): string {
  if (offer.reference == null || offer.realPct == null) {
    const day = trackedDays(history.series) + 1;
    return `Sbírám historii, ${day}. den. Bez reference zatím neřeknu, jestli je sleva reálná.`;
  }

  const name = sourceDisplayName(offer.source);
  const label = referenceLabel(offer.reference, offer);

  if (offer.fake) {
    const pct = offer.claimedDiscountPct;
    const orig = offer.claimedOriginalPrice;
    const head =
      pct != null && orig != null
        ? `${name} počítá slevu ${pct} % z ceny ${formatCzk(orig)}. Za tu se termín posledních 30 dní neprodával.`
        : `${name} nadsazuje původní cenu. Za tu se termín posledních 30 dní neprodával.`;
    if (offer.realPct > 0) {
      return `${head} Ušetříš ${offer.realPct} % (vs. ${label}).`;
    }
    return head;
  }

  // Honest: factual one-liner off the real percentage, baseline, and tier label.
  // "vs. <label>" (not "proti <label>") sidesteps Czech instrumental declension
  // on interpolated place names (offer.locality/country) — "proti Řecku" would
  // need grammar the raw nominative string doesn't have; "vs." stays invariant
  // and matches the board cell / Telegram wording exactly.
  const baseline = offer.baseline;
  if (offer.realPct > 0) {
    const base = baseline != null ? ` vs. ${label} ${formatCzk(baseline)}` : '';
    return `Reálná sleva ${offer.realPct} %${base}.`;
  }
  const rise = Math.abs(offer.realPct);
  const base = baseline != null ? ` (vs. ${label} ${formatCzk(baseline)})` : ` (vs. ${label})`;
  return `Cena je o ${rise} % výš${base}. Zdražuje.`;
}
