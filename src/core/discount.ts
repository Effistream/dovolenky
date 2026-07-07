import { pragueDayString } from './dates.js';

export interface DiscountResult {
  realPct: number | null;
  reference: 'own' | 'omnibus' | 'hotel' | 'locality' | 'market' | null;
  baseline: number | null;
  fake: boolean;
}

export interface ComputeRealDiscountInput {
  current: number;
  ownSnapshots: { price: number; at: string }[];
  omnibus: number | null;
  /**
   * @deprecated Transitional alias for `marketPricesPN` (per-night market
   * bucket prices). Kept so src/core/run.ts and src/core/digest.ts — which
   * still pass total-per-person `marketPrices` — continue to compile until
   * Task 32 rewires them to pass genuine per-night prices. When both
   * `marketPrices` and `marketPricesPN` are supplied, `marketPricesPN` wins.
   * New callers should use `marketPricesPN`.
   */
  marketPrices?: number[];
  /** Per-night market bucket prices (country × month × nights band × board × stars). Min 8 entries. */
  marketPricesPN?: number[];
  /** Subject offer's nights. Required to reach the hotel/locality/market tiers (per-night comparison). */
  nights?: number | null;
  /** Per-night prices of other active terms of the same hotel (hotel_key bucket). Min 4 entries. */
  hotelTermPricesPN?: number[];
  /** Per-night prices of the locality bucket (locality × month × board × stars). Min 8 entries. */
  localityPricesPN?: number[];
  claimedPct: number | null;
  now?: Date;
}

const OWN_WINDOW_DAYS = 30;
const OWN_MIN_SNAPSHOTS = 3;
const OWN_MIN_SPAN_DAYS = 5;
const HOTEL_MIN_PRICES = 4;
const LOCALITY_MIN_PRICES = 8;
const MARKET_MIN_PRICES = 8;
const FAKE_THRESHOLD_PP = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

export function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function ownBaseline(ownSnapshots: { price: number; at: string }[], now: Date): number | null {
  const nowMs = now.getTime();
  const todayPragueDay = pragueDayString(now);
  const windowStartMs = nowMs - OWN_WINDOW_DAYS * DAY_MS;

  const qualifying = ownSnapshots.filter((s) => {
    const t = new Date(s.at).getTime();
    if (!Number.isFinite(t)) return false;
    // exclude today (Europe/Prague calendar day)
    if (pragueDayString(new Date(t)) === todayPragueDay) return false;
    // last 30 days (excluding today)
    return t >= windowStartMs && t < nowMs;
  });

  if (qualifying.length < OWN_MIN_SNAPSHOTS) return null;

  const times = qualifying.map((s) => new Date(s.at).getTime());
  const spanDays = (Math.max(...times) - Math.min(...times)) / DAY_MS;
  if (spanDays < OWN_MIN_SPAN_DAYS) return null;

  return median(qualifying.map((s) => s.price));
}

/**
 * Per-night reference tier: given a bucket of per-night prices and a
 * minimum count, returns the per-night median baseline if the bucket
 * qualifies (enough entries, positive median), else null.
 */
function perNightBaseline(pricesPN: number[], minCount: number): number | null {
  if (pricesPN.length < minCount) return null;
  const m = median(pricesPN);
  return m > 0 ? m : null;
}

export function computeRealDiscount(input: ComputeRealDiscountInput): DiscountResult {
  const now = input.now ?? new Date();
  const nights = input.nights ?? null;
  const hotelTermPricesPN = input.hotelTermPricesPN ?? [];
  const localityPricesPN = input.localityPricesPN ?? [];

  let reference: DiscountResult['reference'] = null;
  let baseline: number | null = null;
  // baseForPct/currentForPct hold the pair used to compute realPct in native
  // units for the winning tier (total for own/omnibus/legacy-market,
  // per-night for hotel/locality/market-PN).
  let baseForPct: number | null = null;
  let currentForPct: number | null = null;

  const own = ownBaseline(input.ownSnapshots, now);
  if (own !== null && own > 0) {
    reference = 'own';
    baseline = own;
    baseForPct = own;
    currentForPct = input.current;
  } else if (input.omnibus !== null && input.omnibus > 0) {
    reference = 'omnibus';
    baseline = input.omnibus;
    baseForPct = input.omnibus;
    currentForPct = input.current;
  } else if (nights !== null && nights >= 1) {
    // Per-night tiers require a valid nights count to normalize `current`.
    const currentPN = Math.round(input.current / nights);

    // marketPricesPN wins when both are supplied; marketPrices is only
    // reinterpreted as per-night when the caller has opted into per-night
    // semantics by also supplying `nights` (see the legacy TOTAL fallback
    // below for callers that pass `nights: null`/omitted).
    const marketPricesPN = input.marketPricesPN ?? input.marketPrices ?? [];

    const hotelBasePN = perNightBaseline(hotelTermPricesPN, HOTEL_MIN_PRICES);
    const localityBasePN = perNightBaseline(localityPricesPN, LOCALITY_MIN_PRICES);
    const marketBasePN = perNightBaseline(marketPricesPN, MARKET_MIN_PRICES);

    if (hotelBasePN !== null) {
      reference = 'hotel';
      baseline = hotelBasePN * nights;
      baseForPct = hotelBasePN;
      currentForPct = currentPN;
    } else if (localityBasePN !== null) {
      reference = 'locality';
      baseline = localityBasePN * nights;
      baseForPct = localityBasePN;
      currentForPct = currentPN;
    } else if (marketBasePN !== null) {
      reference = 'market';
      baseline = marketBasePN * nights;
      baseForPct = marketBasePN;
      currentForPct = currentPN;
    }
  } else if (input.marketPricesPN === undefined && input.marketPrices !== undefined) {
    // Legacy TOTAL-price market tier (pre-Task-31 behavior), preserved for
    // callers that don't yet pass `nights`/`marketPricesPN` (src/core/run.ts,
    // src/core/digest.ts, src/web/api.ts — rewired in Task 32). Without a
    // nights count we cannot normalize per-night, so `marketPrices` is read
    // as-is (whole-stay totals) exactly like the pre-v2 implementation.
    const marketBaseline = perNightBaseline(input.marketPrices ?? [], MARKET_MIN_PRICES);
    if (marketBaseline !== null) {
      reference = 'market';
      baseline = marketBaseline;
      baseForPct = marketBaseline;
      currentForPct = input.current;
    }
  }

  if (baseline === null || reference === null || baseForPct === null || currentForPct === null) {
    return { realPct: null, reference: null, baseline: null, fake: false };
  }

  const realPct = Math.round(((baseForPct - currentForPct) / baseForPct) * 100);
  const fake = input.claimedPct != null && realPct != null && input.claimedPct - realPct >= FAKE_THRESHOLD_PP;

  return { realPct, reference, baseline, fake };
}
