import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBluestyle } from '../src/sources/bluestyle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, 'fixtures/bluestyle/last-minute.html'), 'utf-8');

/** Builds a minimal HTML page containing a `__NEXT_DATA__` apolloState with the given CheapestTerm entries. */
function buildHtml(terms: Record<string, unknown>[]): string {
  const apolloState: Record<string, unknown> = {};
  terms.forEach((term, i) => {
    apolloState[`CheapestTerm:${i}`] = { __typename: 'CheapestTerm', ...term };
  });
  const nextData = { apolloState };
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
}

function baseTerm(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hotelName: 'Test Hotel',
    hotelStars: 'STAR_4',
    destinationName: 'Testville',
    boardingType: 'All Inclusive',
    departureDate: '2026-08-01',
    nightCount: 7,
    priceFrom: 10000,
    percentageDiscount: 20,
    url: '/egypt/testville/test-hotel/?date=2026-08-01&duration=7',
    ...overrides,
  };
}

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
    // The country is derived from the first path segment of the offer URL instead
    // (/egypt/hurghada/... -> "egypt" -> normalizeCountry -> "Egypt"), and destinationName
    // becomes the locality.
    expect(first!.country).toBe('Egypt');
    expect(first!.locality).toBe('Hurghada');
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

  it('tags transport as flight (fly-package last-minute section) so flight-only profiles see it', () => {
    // Blue Style is a fly-package operator and /last-minute/ terms carry depCity/arrCity/airline;
    // transport is hardcoded 'flight' (same as fischer/exim) rather than 'unknown', which would
    // hide every offer from a flight-only profile.
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(o.transport).toBe('flight');
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

  it('derives country from the URL slug (not destinationName) for every fixture offer', () => {
    // Maps each offer's url first path segment to the expected normalized country, verifying
    // that destinationName (city/resort) never leaks into `country` and that locality holds
    // the original destinationName instead.
    const expectedBySlug: Record<string, string> = {
      egypt: 'Egypt',
      kapverdy: 'Kapverdy',
      turecko: 'Turecko',
      tunisko: 'Tunisko',
      recko: 'Řecko',
      spanelsko: 'Španělsko',
      italie: 'Itálie',
    };
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      const path = new URL(o.url).pathname;
      const slug = path.split('/').find((seg) => seg.length > 0);
      expect(slug).toBeDefined();
      expect(o.country).toBe(expectedBySlug[slug as string]);
      expect(o.locality).not.toBeNull();
    }
  });
});

describe('parseBluestyle: country derivation from URL slug', () => {
  it('maps /egypt/hurghada/... to country "Egypt" and locality "Hurghada"', () => {
    const html = buildHtml([
      baseTerm({
        hotelName: 'Hotel Pyramisa Beach Resort',
        destinationName: 'Hurghada',
        url: '/egypt/hurghada/hotel-pyramisa-beach-resort/?date=2026-07-09&duration=2',
      }),
    ]);
    const offers = parseBluestyle(html);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.country).toBe('Egypt');
    expect(offers[0]!.locality).toBe('Hurghada');
  });
});

describe('parseBluestyle: percentageDiscount guard', () => {
  it('keeps claimedDiscountPct/claimedOriginalPrice null when percentageDiscount is 100 (no Infinity)', () => {
    const html = buildHtml([baseTerm({ percentageDiscount: 100 })]);
    const offers = parseBluestyle(html);
    expect(offers).toHaveLength(1);
    const offer = offers[0]!;
    expect(offer.claimedDiscountPct).toBeNull();
    expect(offer.claimedOriginalPrice).toBeNull();
    expect(Number.isFinite(offer.claimedOriginalPrice ?? 0)).toBe(true);
  });

  it('keeps claimedDiscountPct/claimedOriginalPrice null when percentageDiscount is above 100', () => {
    const html = buildHtml([baseTerm({ percentageDiscount: 150 })]);
    const offers = parseBluestyle(html);
    expect(offers[0]!.claimedDiscountPct).toBeNull();
    expect(offers[0]!.claimedOriginalPrice).toBeNull();
  });

  it('keeps a valid discount in (0, 100) working as before', () => {
    const html = buildHtml([baseTerm({ percentageDiscount: 25, priceFrom: 7500 })]);
    const offers = parseBluestyle(html);
    const offer = offers[0]!;
    expect(offer.claimedDiscountPct).toBe(25);
    expect(offer.claimedOriginalPrice).toBe(Math.round(7500 / (1 - 25 / 100)));
  });
});
