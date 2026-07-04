import { describe, it, expect } from 'vitest';
import { computeRealDiscount, median } from '../src/core/discount.js';

const NOW = new Date('2026-07-04T12:00:00Z');

function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

describe('median', () => {
  it('computes median for odd and even length arrays', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
  });
});

describe('computeRealDiscount', () => {
  it('1) own: 5 snapshots over last 10 days, median 20000, current 15000 -> realPct 25, reference own', () => {
    const ownSnapshots = [
      { price: 20000, at: daysAgo(10) },
      { price: 19000, at: daysAgo(8) },
      { price: 20000, at: daysAgo(6) },
      { price: 21000, at: daysAgo(4) },
      { price: 20000, at: daysAgo(2) },
    ];
    const result = computeRealDiscount({
      current: 15000,
      ownSnapshots,
      omnibus: null,
      marketPrices: [],
      claimedPct: null,
      now: NOW,
    });
    expect(result.reference).toBe('own');
    expect(result.baseline).toBe(20000);
    expect(result.realPct).toBe(25);
  });

  it('2a) own insufficient (only 2 snapshots) + omnibus present -> reference omnibus, realPct ~17', () => {
    const ownSnapshots = [
      { price: 19000, at: daysAgo(10) },
      { price: 20000, at: daysAgo(5) },
    ];
    const result = computeRealDiscount({
      current: 15000,
      ownSnapshots,
      omnibus: 18000,
      marketPrices: [],
      claimedPct: null,
      now: NOW,
    });
    expect(result.reference).toBe('omnibus');
    expect(result.baseline).toBe(18000);
    expect(result.realPct).toBe(17);
  });

  it('2b) own insufficient (4 snapshots spanning only 3 days) + omnibus present -> reference omnibus, realPct ~17', () => {
    const ownSnapshots = [
      { price: 19000, at: daysAgo(3) },
      { price: 20000, at: daysAgo(2.5) },
      { price: 20500, at: daysAgo(1.5) },
      { price: 19500, at: daysAgo(0.5) },
    ];
    const result = computeRealDiscount({
      current: 15000,
      ownSnapshots,
      omnibus: 18000,
      marketPrices: [],
      claimedPct: null,
      now: NOW,
    });
    expect(result.reference).toBe('omnibus');
    expect(result.baseline).toBe(18000);
    expect(result.realPct).toBe(17);
  });

  it('3) no own/omnibus, 8 marketPrices with median 16000, current 12000 -> market, 25', () => {
    const marketPrices = [10000, 12000, 14000, 15000, 17000, 18000, 20000, 22000]; // median (15000+17000)/2=16000
    const result = computeRealDiscount({
      current: 12000,
      ownSnapshots: [],
      omnibus: null,
      marketPrices,
      claimedPct: null,
      now: NOW,
    });
    expect(result.reference).toBe('market');
    expect(result.baseline).toBe(16000);
    expect(result.realPct).toBe(25);
  });

  it('4) market with fewer than 8 values -> reference null, realPct null, fake false', () => {
    const marketPrices = [10000, 12000, 14000, 15000, 17000, 18000, 20000]; // only 7
    const result = computeRealDiscount({
      current: 12000,
      ownSnapshots: [],
      omnibus: null,
      marketPrices,
      claimedPct: 30,
      now: NOW,
    });
    expect(result.reference).toBeNull();
    expect(result.realPct).toBeNull();
    expect(result.baseline).toBeNull();
    expect(result.fake).toBe(false);
  });

  it('5) price increase: baseline 10000, current 12000 -> realPct -20', () => {
    const result = computeRealDiscount({
      current: 12000,
      ownSnapshots: [],
      omnibus: 10000,
      marketPrices: [],
      claimedPct: null,
      now: NOW,
    });
    expect(result.reference).toBe('omnibus');
    expect(result.realPct).toBe(-20);
  });

  it('6) fake discount flag: claimed 45 vs real 22 -> true; claimed 30 vs real 22 -> false; claimed null -> false', () => {
    const base = {
      current: 7800,
      ownSnapshots: [],
      marketPrices: [],
      now: NOW,
    };
    // baseline 10000, current 7800 -> realPct = round((10000-7800)/10000*100) = 22
    const withClaimed45 = computeRealDiscount({ ...base, omnibus: 10000, claimedPct: 45 });
    expect(withClaimed45.realPct).toBe(22);
    expect(withClaimed45.fake).toBe(true);

    const withClaimed30 = computeRealDiscount({ ...base, omnibus: 10000, claimedPct: 30 });
    expect(withClaimed30.realPct).toBe(22);
    expect(withClaimed30.fake).toBe(false);

    const withClaimedNull = computeRealDiscount({ ...base, omnibus: 10000, claimedPct: null });
    expect(withClaimedNull.realPct).toBe(22);
    expect(withClaimedNull.fake).toBe(false);
  });

  it('7) own snapshots older than 30 days and today are ignored (now fixed)', () => {
    const ownSnapshots = [
      { price: 99999, at: daysAgo(31) }, // too old, excluded
      { price: 88888, at: daysAgo(45) }, // too old, excluded
      { price: 20000, at: daysAgo(20) },
      { price: 19000, at: daysAgo(15) },
      { price: 21000, at: daysAgo(10) },
      { price: 12345, at: NOW.toISOString() }, // today, excluded
    ];
    const result = computeRealDiscount({
      current: 15000,
      ownSnapshots,
      omnibus: null,
      marketPrices: [],
      claimedPct: null,
      now: NOW,
    });
    // qualifying snapshots: 20000 (day 20), 19000 (day 15), 21000 (day 10) -> median 20000, span 10 days >= 5
    expect(result.reference).toBe('own');
    expect(result.baseline).toBe(20000);
    expect(result.realPct).toBe(25);
  });

  it('no reference available -> realPct null, reference null, baseline null, fake false', () => {
    const result = computeRealDiscount({
      current: 15000,
      ownSnapshots: [],
      omnibus: null,
      marketPrices: [],
      claimedPct: 50,
      now: NOW,
    });
    expect(result.reference).toBeNull();
    expect(result.realPct).toBeNull();
    expect(result.baseline).toBeNull();
    expect(result.fake).toBe(false);
  });
});
