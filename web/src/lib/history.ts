/**
 * Pure, DOM-free model builders for the offer detail (Task 27): the SVG price
 * chart, the facts kv block, and the verdict sentence. Every function here is
 * unit-tested (history.test.ts) and side-effect free so the tests run under node
 * with no DOM. Copy follows design-system/MASTER.md (Czech, concrete numbers,
 * active voice, no exclamations, fake-slevy verdict names the actor).
 */
import type { HistoryResponse, Offer } from './types.js';
import { formatCzk, formatNumber } from './format.js';
import { formatDayMonth } from './term.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Source display names — title-case for prose ("Exim počítá…"), distinct from
// term.ts#sourceLabel which uppercases for the board's mono ZDROJ cell.
// ---------------------------------------------------------------------------
const SOURCE_NAMES: Record<string, string> = {
  invia: 'Invia',
  fischer: 'Fischer',
  exim: 'Exim',
  cedok: 'Čedok',
  'blue-style': 'Blue Style',
  'zajezdy-cz': 'Zajezdy.cz',
  'dovolena-cz': 'Dovolena.cz',
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
}

// Inner plot padding: leaves room for the top claimed-line label and the bottom
// axis-date labels so nothing drawn ever collides with the viewBox edges.
const PLOT_TOP = 34;
const PLOT_BOTTOM_PAD = 22;
const BAND_HEIGHT = 18;

/**
 * Scales an offer's price history into an SVG-ready model within `viewBox`.
 * Returns null for a degenerate series (<2 points) — the caller shows a
 * "zatím málo dat na graf" note instead of a chart.
 *
 * The vertical scale spans every value we draw (all series prices, the median
 * band, and the claimed-original line) so the claimed line always sits visibly
 * above the curve and the band overlaps it, matching the mockup. Higher price =
 * smaller y (top), like the sparkline.
 */
export function buildChart(
  viewBox: ChartViewBox,
  history: HistoryResponse,
): ChartModel | null {
  const { series, median, claimedOriginalPrice } = history;
  if (series.length < 2) return null;

  const prices = series.map((p) => p.price);
  const floorY = viewBox.height - PLOT_BOTTOM_PAD;

  // Value range must cover the curve, the band centre, and the claimed line.
  const values = [...prices];
  if (median != null) values.push(median);
  if (claimedOriginalPrice != null) values.push(claimedOriginalPrice);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  const innerH = floorY - PLOT_TOP;
  const x = (i: number): number =>
    (i / (series.length - 1)) * viewBox.width;
  // Higher value → smaller y (nearer PLOT_TOP). Flat range → mid plot.
  const y = (value: number): number =>
    span === 0 ? PLOT_TOP + innerH / 2 : PLOT_TOP + (1 - (value - min) / span) * innerH;

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
          y: round(y(claimedOriginalPrice)),
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
 */
export function buildVerdict(offer: Offer, history: HistoryResponse): string {
  if (offer.reference == null || offer.realPct == null) {
    const day = trackedDays(history.series) + 1;
    return `Sbírám historii, ${day}. den. Bez reference zatím neřeknu, jestli je sleva reálná.`;
  }

  const name = sourceDisplayName(offer.source);

  if (offer.fake) {
    const pct = offer.claimedDiscountPct;
    const orig = offer.claimedOriginalPrice;
    const head =
      pct != null && orig != null
        ? `${name} počítá slevu ${pct} % z ceny ${formatCzk(orig)}. Za tu se termín posledních 30 dní neprodával.`
        : `${name} nadsazuje původní cenu. Za tu se termín posledních 30 dní neprodával.`;
    if (offer.realPct > 0) {
      return `${head} Proti reálnému trhu ušetříš ${offer.realPct} %.`;
    }
    return head;
  }

  // Honest: factual one-liner off the real percentage and baseline.
  const baseline = offer.baseline;
  if (offer.realPct > 0) {
    const base = baseline != null ? ` proti mediánu ${formatCzk(baseline)}` : '';
    return `Reálná sleva ${offer.realPct} %${base} za posledních 30 dní.`;
  }
  const rise = Math.abs(offer.realPct);
  const base = baseline != null ? ` mediánem ${formatCzk(baseline)}` : ' mediánem';
  return `Cena je o ${rise} % nad${base} za posledních 30 dní. Zdražuje.`;
}
