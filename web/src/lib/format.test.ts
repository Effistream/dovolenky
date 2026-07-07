import { describe, it, expect } from 'vitest';
import {
  formatCzk,
  formatNumber,
  discountTone,
  formatDiscount,
  profileParam,
  referenceLabel,
  sparklinePath,
} from './format.js';

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

describe('referenceLabel', () => {
  it('own → static "30denní medián"', () => {
    expect(referenceLabel('own', { locality: null, country: null })).toBe('30denní medián');
  });
  it('omnibus → static "Omnibus 30denní min."', () => {
    expect(referenceLabel('omnibus', { locality: null, country: null })).toBe('Omnibus 30denní min.');
  });
  it('hotel → static "tento hotel"', () => {
    expect(referenceLabel('hotel', { locality: 'Kréta', country: 'Řecko' })).toBe('tento hotel');
  });
  it('locality → the offer\'s locality', () => {
    expect(referenceLabel('locality', { locality: 'Kréta', country: 'Řecko' })).toBe('Kréta');
  });
  it('locality → falls back to "lokalita" when null', () => {
    expect(referenceLabel('locality', { locality: null, country: 'Řecko' })).toBe('lokalita');
  });
  it('market → the offer\'s country', () => {
    expect(referenceLabel('market', { locality: 'Kréta', country: 'Řecko' })).toBe('Řecko');
  });
  it('market → falls back to "trh" when null', () => {
    expect(referenceLabel('market', { locality: 'Kréta', country: null })).toBe('trh');
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
