export interface DiscountResult {
  realPct: number | null;
  reference: 'own' | 'omnibus' | 'market' | null;
  baseline: number | null;
  fake: boolean;
}

export interface ComputeRealDiscountInput {
  current: number;
  ownSnapshots: { price: number; at: string }[];
  omnibus: number | null;
  marketPrices: number[];
  claimedPct: number | null;
  now?: Date;
}

const OWN_WINDOW_DAYS = 30;
const OWN_MIN_SNAPSHOTS = 3;
const OWN_MIN_SPAN_DAYS = 5;
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
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const windowStartMs = nowMs - OWN_WINDOW_DAYS * DAY_MS;

  const qualifying = ownSnapshots.filter((s) => {
    const t = new Date(s.at).getTime();
    if (!Number.isFinite(t)) return false;
    // exclude today
    if (t >= todayStartMs) return false;
    // last 30 days (excluding today)
    return t >= windowStartMs && t < nowMs;
  });

  if (qualifying.length < OWN_MIN_SNAPSHOTS) return null;

  const times = qualifying.map((s) => new Date(s.at).getTime());
  const spanDays = (Math.max(...times) - Math.min(...times)) / DAY_MS;
  if (spanDays < OWN_MIN_SPAN_DAYS) return null;

  return median(qualifying.map((s) => s.price));
}

export function computeRealDiscount(input: {
  current: number;
  ownSnapshots: { price: number; at: string }[];
  omnibus: number | null;
  marketPrices: number[];
  claimedPct: number | null;
  now?: Date;
}): DiscountResult {
  const now = input.now ?? new Date();

  let reference: 'own' | 'omnibus' | 'market' | null = null;
  let baseline: number | null = null;

  const own = ownBaseline(input.ownSnapshots, now);
  if (own !== null) {
    reference = 'own';
    baseline = own;
  } else if (input.omnibus !== null) {
    reference = 'omnibus';
    baseline = input.omnibus;
  } else if (input.marketPrices.length >= MARKET_MIN_PRICES) {
    reference = 'market';
    baseline = median(input.marketPrices);
  }

  if (baseline === null || reference === null) {
    return { realPct: null, reference: null, baseline: null, fake: false };
  }

  const realPct = Math.round(((baseline - input.current) / baseline) * 100);
  const fake = input.claimedPct != null && realPct != null && input.claimedPct - realPct >= FAKE_THRESHOLD_PP;

  return { realPct, reference, baseline, fake };
}
