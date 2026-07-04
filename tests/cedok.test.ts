import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCedokListing } from '../src/sources/cedok.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, 'fixtures/cedok/last-minute-p1.html'), 'utf-8');

describe('parseCedokListing', () => {
  const offers = parseCedokListing(fixture);

  it('parses the real card count from the fixture (deduped: page renders each of the 25 offers twice)', () => {
    // The raw fixture contains 50 `[data-testid="offer-list-item"]` nodes, but they are
    // two renderings (mobile-width card + desktop "enlarged" card) of the SAME 25 offers.
    // The parser dedupes by sourceOfferKey (hotel code from the URL), so 25 is the real count.
    expect(offers.length).toBe(25);
  });

  it('parses the first offer with real values from the fixture', () => {
    const first = offers[0];
    expect(first).toBeDefined();
    expect(first!.title).toBe('Hotel Jelení Dvůr');
    expect(first!.country).toBe('Česká republika');
    expect(first!.locality).toBe('Praha');
    expect(first!.pricePerPerson).toBe(880);
    expect(first!.stars).toBe(3);
    expect(first!.transport).toBe('own');
    expect(first!.board).toBe('BB');
    expect(first!.nights).toBe(1);
    expect(first!.departureDate).toBe('2026-07-05');
    expect(first!.sourceOfferKey).toBe('SCZ2VJD');
    expect(first!.source).toBe('cedok');
    expect(first!.url).toBe(
      'https://www.cedok.cz/dovolena/ceska-republika/praha/hotel-jeleni-dvur,SCZ2VJD/?id=CgVDZWRvaxIEVklUQxoDQ1pLIgdTQ1oyVkpEKAM6BEtMMjZCBgiAvabSBkoGCIDgq9IGUAGSAQYIgL2m0gaaAQYIgOCr0gaiAQUKA0RCTKoBAwoBRvIBCQoHUmVzYWJlZQ%253D%253D',
    );
  });

  it('holds invariants for every offer', () => {
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(o.source).toBe('cedok');
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(Number.isInteger(o.pricePerPerson)).toBe(true);
      expect(o.url.startsWith('https://www.cedok.cz/')).toBe(true);
      expect(o.title.length).toBeGreaterThan(0);
      expect(o.sourceOfferKey.length).toBeGreaterThan(0);
    }
  });

  it('computes claimedDiscountPct/claimedOriginalPrice consistently for cards that carry a base-price', () => {
    // This fixture (priceAsc, page 1 = cheapest offers) happens to contain zero cards with a
    // base-price strike-through (confirmed against a default-order fetch during recon: the
    // `base-price` testid exists on the site but only appears on discounted cards, which are
    // not among the very cheapest). The invariant below still guards the parser's behavior
    // for the general case, and degrades gracefully to "no cards" on this fixture.
    const withOriginal = offers.filter((o) => o.claimedOriginalPrice !== null);
    for (const o of withOriginal) {
      expect(o.claimedOriginalPrice as number).toBeGreaterThan(o.pricePerPerson);
      expect(o.claimedDiscountPct).not.toBeNull();
      expect(o.claimedDiscountPct as number).toBeGreaterThan(0);
    }
  });

  it('deduplicates offers appearing in both mobile and desktop-enlarged card renderings', () => {
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
