/**
 * Pure, framework-free helpers for the board. Every function here is unit-tested
 * (web/src/lib/format.test.ts) and must stay side-effect free so the tests can
 * run under node with no DOM. Formatting follows design-system/MASTER.md: Czech
 * copy, concrete numbers, no exclamations.
 */
import type { Offer, ProfileFilter, Reference } from './types.js';

/** Non-breaking space so "9 990 Kč" never wraps between digits and unit. */
const NBSP = ' ';

/**
 * Czech thousands grouping with a Kč suffix: 9990 → "9 990 Kč". Uses a plain
 * regex (not Intl) so output is deterministic across environments and matches
 * the mockup's "9 990 Kč" exactly. Non-finite input yields an em-dash-free "—".
 */
export function formatCzk(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${sign}${digits}${NBSP}Kč`;
}

/** Same grouping without the unit, for baseline references ("medián 14 500"). */
export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  return (
    sign +
    Math.abs(rounded)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
  );
}

/**
 * The visual tone of the REÁLNÁ cell, matching the mockup's `.real` modifiers
 * and MASTER.md's component rules:
 *  - 'none'  → no reference yet ("SBÍRÁM HISTORII")
 *  - 'up'    → price rose vs. baseline (realPct ≤ 0, "+X % zdražuje")
 *  - 'good'  → real discount ≥ 15 %
 *  - 'mid'   → real discount 1–14 %
 */
export type DiscountTone = 'good' | 'mid' | 'up' | 'none';

export function discountTone(realPct: number | null): DiscountTone {
  if (realPct == null) return 'none';
  if (realPct <= 0) return 'up';
  if (realPct >= 15) return 'good';
  return 'mid';
}

/**
 * "−31 %" / "+4 %" — the discount figure with a leading sign. A positive realPct
 * is a real saving, shown with the U+2212 minus (as in the mockup); realPct ≤ 0
 * is a price rise, shown with a plus. Null → "" (caller renders "SBÍRÁM HISTORII").
 */
export function formatDiscount(realPct: number | null): string {
  if (realPct == null) return '';
  if (realPct <= 0) return `+${Math.abs(realPct)} %`;
  return `−${realPct} %`;
}

/**
 * Reference-tier label (spec §15) — mirrors src/core/format.ts#referenceLabel
 * so the board/detail show the exact same wording as the Telegram message for
 * the same offer. own/omnibus are static phrases; hotel is a fixed phrase
 * ("tento hotel" — the subject *is* the hotel); locality/market interpolate
 * the offer's own locality/country, falling back to a generic noun when that
 * field is null (should be rare in practice — the bucket query requires it).
 */
export function referenceLabel(reference: NonNullable<Reference>, offer: Pick<Offer, 'locality' | 'country'>): string {
  switch (reference) {
    case 'own':
      return '30denní medián';
    case 'omnibus':
      return 'Omnibus 30denní min.';
    case 'hotel':
      return 'tento hotel';
    case 'locality':
      return offer.locality ?? 'lokalita';
    case 'market':
      return offer.country ?? 'trh';
  }
}

/**
 * Maps a profile chip to the /api/offers `profile=` query value. 'all' → no
 * param (undefined); the other two pass their config key verbatim. Board sorting
 * and filtering now live in lib/filters.ts (Task 29); this module keeps only the
 * cell formatters + profile mapping still used by BoardRow/App.
 */
export function profileParam(profile: ProfileFilter): string | undefined {
  return profile === 'all' ? undefined : profile;
}

export interface SparklinePath {
  /** "x,y x,y …" for the <polyline points> attribute. */
  points: string;
  /** Endpoint dot coordinates (last point). */
  endX: number;
  endY: number;
  /** True when the last price is below the first → falling → green. */
  falling: boolean;
}

/**
 * Builds an inline-SVG sparkline from a price series into a fixed viewBox
 * (default 64×22 like the mockup). Prices are min/max-normalised to the padded
 * height, inverted so higher price = higher on screen. `falling` compares last
 * vs. first price so the caller can colour a downward line green (a price drop
 * is the good signal). A flat/single-point series maps to the vertical middle.
 */
export function sparklinePath(
  prices: number[],
  width = 64,
  height = 22,
  pad = 3,
): SparklinePath | null {
  if (prices.length === 0) return null;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min;
  const innerH = height - pad * 2;
  const n = prices.length;

  const x = (i: number): number =>
    n === 1 ? width - pad : pad + (i / (n - 1)) * (width - pad * 2);
  // Higher price → smaller y (top). Flat series → vertical middle.
  const y = (price: number): number =>
    span === 0 ? height / 2 : pad + (1 - (price - min) / span) * innerH;

  const coords = prices.map((p, i) => ({ px: round(x(i)), py: round(y(p)) }));
  const points = coords.map((c) => `${c.px},${c.py}`).join(' ');
  const last = coords[coords.length - 1]!;
  const falling = prices[n - 1]! < prices[0]!;

  return { points, endX: last.px, endY: last.py, falling };
}

/** Round to 1 decimal so SVG coordinate strings stay compact and deterministic. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}
