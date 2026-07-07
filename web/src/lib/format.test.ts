import { describe, it, expect } from 'vitest';
import {
  formatCzk,
  formatNumber,
  discountTone,
  formatDiscount,
  sortOffers,
  filterOffers,
  countriesOf,
  profileParam,
  sparklinePath,
} from './format.js';
import type { Offer } from './types.js';

// A minimal offer factory — only the fields a given test asserts on matter.
function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: 1,
    source: 'invia',
    title: 'Hotel',
    country: 'Řecko',
    locality: 'Kréta',
    stars: 4,
    board: 'AI',
    transport: 'flight',
    departureAirport: 'PRG',
    departureDate: '2026-08-15',
    nights: 7,
    pricePerPerson: 12000,
    priceTotal: 24000,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    tourOperator: null,
    url: 'https://x/1',
    realPct: 20,
    reference: 'market',
    baseline: 15000,
    fake: false,
    alternatives: [],
    sparkline: [],
    ...over,
  };
}

describe('formatCzk', () => {
  it('groups thousands with a non-breaking space and Kč suffix', () => {
    expect(formatCzk(9990)).toBe('9 990 Kč');
    expect(formatCzk(1234567)).toBe('1 234 567 Kč');
    expect(formatCzk(990)).toBe('990 Kč');
  });
  it('rounds and handles negatives', () => {
    expect(formatCzk(9990.4)).toBe('9 990 Kč');
    expect(formatCzk(-1500)).toBe('-1 500 Kč');
  });
  it('returns an em-dash-free placeholder for nullish/non-finite', () => {
    expect(formatCzk(null)).toBe('—');
    expect(formatCzk(undefined)).toBe('—');
    expect(formatCzk(Number.NaN)).toBe('—');
  });
});

describe('formatNumber', () => {
  it('groups without a unit', () => {
    expect(formatNumber(14500)).toBe('14 500');
    expect(formatNumber(19400)).toBe('19 400');
  });
  it('placeholder for nullish', () => {
    expect(formatNumber(null)).toBe('—');
  });
});

describe('discountTone', () => {
  it('null → none (still collecting history)', () => {
    expect(discountTone(null)).toBe('none');
  });
  it('≥15 → good', () => {
    expect(discountTone(15)).toBe('good');
    expect(discountTone(31)).toBe('good');
  });
  it('1–14 → mid', () => {
    expect(discountTone(1)).toBe('mid');
    expect(discountTone(14)).toBe('mid');
  });
  it('≤0 → up (price rose)', () => {
    expect(discountTone(0)).toBe('up');
    expect(discountTone(-4)).toBe('up');
  });
});

describe('formatDiscount', () => {
  it('positive real discount uses a minus sign (a saving)', () => {
    expect(formatDiscount(31)).toBe('−31 %');
  });
  it('non-positive uses a plus (zdražení)', () => {
    expect(formatDiscount(-4)).toBe('+4 %');
    expect(formatDiscount(0)).toBe('+0 %');
  });
  it('null → empty', () => {
    expect(formatDiscount(null)).toBe('');
  });
});

describe('sortOffers', () => {
  it('sorts by realPct desc with nulls last, without mutating', () => {
    const input = [
      offer({ id: 1, realPct: 10 }),
      offer({ id: 2, realPct: null }),
      offer({ id: 3, realPct: 31 }),
      offer({ id: 4, realPct: 15 }),
    ];
    const out = sortOffers(input);
    expect(out.map((o) => o.id)).toEqual([3, 4, 1, 2]);
    // original untouched
    expect(input.map((o) => o.id)).toEqual([1, 2, 3, 4]);
  });
  it('keeps both-null pairs stable', () => {
    const input = [offer({ id: 1, realPct: null }), offer({ id: 2, realPct: null })];
    expect(sortOffers(input).map((o) => o.id)).toEqual([1, 2]);
  });
});

describe('filterOffers', () => {
  const offers = [
    offer({ id: 1, country: 'Řecko' }),
    offer({ id: 2, country: 'Turecko' }),
    offer({ id: 3, country: null }),
  ];
  it('empty selection passes everything through', () => {
    expect(filterOffers(offers, { countries: [] }).map((o) => o.id)).toEqual([1, 2, 3]);
  });
  it('keeps only selected countries', () => {
    expect(filterOffers(offers, { countries: ['Řecko'] }).map((o) => o.id)).toEqual([1]);
    expect(
      filterOffers(offers, { countries: ['Řecko', 'Turecko'] }).map((o) => o.id),
    ).toEqual([1, 2]);
  });
  it('drops null-country rows when a filter is active', () => {
    expect(filterOffers(offers, { countries: ['Turecko'] }).map((o) => o.id)).toEqual([2]);
  });
});

describe('countriesOf', () => {
  it('returns distinct, cs-sorted, non-null countries', () => {
    const offers = [
      offer({ country: 'Turecko' }),
      offer({ country: 'Řecko' }),
      offer({ country: 'Řecko' }),
      offer({ country: null }),
      offer({ country: 'Egypt' }),
    ];
    expect(countriesOf(offers)).toEqual(['Egypt', 'Řecko', 'Turecko']);
  });
});

describe('profileParam', () => {
  it('all → undefined (no query param), others pass verbatim', () => {
    expect(profileParam('all')).toBeUndefined();
    expect(profileParam('leto-more')).toBe('leto-more');
    expect(profileParam('last-minute')).toBe('last-minute');
  });
});

describe('sparklinePath', () => {
  it('null for an empty series', () => {
    expect(sparklinePath([])).toBeNull();
  });
  it('marks a falling series (last < first)', () => {
    const p = sparklinePath([100, 90, 80]);
    expect(p).not.toBeNull();
    expect(p!.falling).toBe(true);
  });
  it('marks a rising series as not falling', () => {
    const p = sparklinePath([80, 90, 100]);
    expect(p!.falling).toBe(false);
  });
  it('inverts price to y (higher price = smaller y) within padding', () => {
    // Two points, low then high. Endpoint (high) should sit near the top pad.
    const p = sparklinePath([100, 200], 64, 22, 3)!;
    expect(p.endX).toBe(61); // width - pad
    expect(p.endY).toBe(3); // top pad — highest price
    // The first, lowest price maps to the bottom (height - pad = 19).
    expect(p.points.startsWith('3,19')).toBe(true);
  });
  it('flat series maps to the vertical middle', () => {
    const p = sparklinePath([100, 100, 100], 64, 22, 3)!;
    expect(p.endY).toBe(11); // height / 2
    expect(p.falling).toBe(false);
  });
  it('single point sits at the right edge', () => {
    const p = sparklinePath([500], 64, 22, 3)!;
    expect(p.endX).toBe(61);
    expect(p.points).toBe('61,11');
  });
});
