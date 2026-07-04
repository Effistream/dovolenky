import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBluestyle } from '../src/sources/bluestyle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, 'fixtures/bluestyle/last-minute.html'), 'utf-8');

describe('parseBluestyle', () => {
  const offers = parseBluestyle(fixture);

  it('parses the real offer count from the fixture (10 CheapestTerm entries on /last-minute/)', () => {
    // Recon note in the task brief estimated ~50 offers, but the live fixture (captured
    // 2026-07-04) only exposes 10 fully-populated `CheapestTerm` objects in apolloState on
    // the /last-minute/ page itself. Country pages (/recko/, /turecko/, /egypt/) only carry
    // *partial* CheapestTerm fragments (missing hotelName/board/stars/discount — just a
    // per-location "cheapest teaser" referenced via LocationCountry.cheapestTerm), which the
    // parser correctly skips since they lack a title.
    expect(offers.length).toBe(10);
  });

  it('parses the first offer with real values from the fixture', () => {
    const first = offers[0];
    expect(first).toBeDefined();
    expect(first!.title).toBe('Hotel Pyramisa Beach Resort');
    // destinationName on Blue Style is the resort/city name ("Hurghada"), not the country.
    // normalizeCountry has no match for it in its known-country list, so it falls back to
    // returning the raw (trimmed) string as-is — this is the documented fallback behavior,
    // not a bug in this adapter.
    expect(first!.country).toBe('Hurghada');
    expect(first!.stars).toBe(5);
    expect(first!.board).toBe('AI');
    expect(first!.departureDate).toBe('2026-07-09');
    expect(first!.nights).toBe(2);
    expect(first!.pricePerPerson).toBe(11990);
    expect(first!.claimedDiscountPct).toBe(59);
    expect(first!.claimedOriginalPrice).toBe(Math.round(11990 / (1 - 59 / 100)));
    expect(first!.source).toBe('bluestyle');
    expect(first!.url).toBe(
      'https://www.blue-style.cz/egypt/hurghada/hotel-pyramisa-beach-resort/?date=2026-07-09&duration=2&depCity=2&arrCity=9&airline=Hello%20Jets',
    );
  });

  it('holds invariants for every offer', () => {
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(o.source).toBe('bluestyle');
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(Number.isInteger(o.pricePerPerson)).toBe(true);
      expect(o.url.startsWith('https://www.blue-style.cz/')).toBe(true);
      expect(o.title.length).toBeGreaterThan(0);
      expect(o.sourceOfferKey.length).toBeGreaterThan(0);
    }
  });

  it('computes claimedDiscountPct/claimedOriginalPrice for offers carrying a percentageDiscount', () => {
    // All 10 offers in this fixture happen to carry a positive percentageDiscount.
    const withDiscount = offers.filter((o) => o.claimedDiscountPct !== null);
    expect(withDiscount.length).toBeGreaterThan(0);
    for (const o of withDiscount) {
      expect(o.claimedDiscountPct as number).toBeGreaterThan(0);
      expect(o.claimedOriginalPrice).not.toBeNull();
      expect(o.claimedOriginalPrice as number).toBeGreaterThan(o.pricePerPerson);
      expect(o.claimedOriginalPrice).toBe(Math.round(o.pricePerPerson / (1 - (o.claimedDiscountPct as number) / 100)));
    }
  });

  it('deduplicates offers by sourceOfferKey', () => {
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
