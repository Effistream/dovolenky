import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDovolena, dovolena } from '../src/sources/dovolena.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tripListingFixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/dovolena/tripListing.json'), 'utf-8'),
);
const REQUEST_URL = 'https://dovolena.cz/api/trip-listing/tripListing?destination=4826&adult=2&page=1';

describe('parseDovolena (fixture, destination=4826 Řecko)', () => {
  const offers = parseDovolena(tripListingFixture, REQUEST_URL);

  it('parses all 10 hotels from page 1 (no silent drops)', () => {
    expect(offers.length).toBe(10);
  });

  it('maps the first hotel (Hotel Theonia) with hardcoded real values', () => {
    const first = offers[0]!;
    expect(first.source).toBe('dovolena');
    expect(first.title).toBe('Hotel Theonia');
    expect(first.country).toBe('Řecko');
    expect(first.locality).toBe('Ostrovy');
    expect(first.stars).toBe(2);
    expect(first.board).toBe('BB');
    expect(first.transport).toBe('flight');
    expect(first.pricePerPerson).toBe(4849);
    expect(first.priceTotal).toBe(9698);
    expect(first.claimedOriginalPrice).toBeNull();
    expect(first.claimedDiscountPct).toBeNull();
    expect(first.departureDate).toBeNull();
    expect(first.nights).toBeNull();
    expect(first.sourceOfferKey).toBe('954985');
    expect(first.url).toBe(REQUEST_URL);
  });

  it('maps a "Bez stravy" hotel to board none (Maritsa Studios)', () => {
    const second = offers[1]!;
    expect(second.title).toBe('Maritsa Studios');
    expect(second.board).toBe('none');
  });

  it('enforces invariants: positive price, source tag, country canonical-or-null, departureDate null OK', () => {
    for (const offer of offers) {
      expect(offer.pricePerPerson).toBeGreaterThan(0);
      expect(offer.source).toBe('dovolena');
      expect(offer.sourceOfferKey.length).toBeGreaterThan(0);
      expect(offer.country === null || typeof offer.country === 'string').toBe(true);
      if (offer.country !== null) {
        expect(offer.country).not.toBe(offer.locality);
      }
      // Hotel-level offers from this source have no departure date/nights — expected, not a bug.
      expect(offer.departureDate).toBeNull();
      expect(offer.nights).toBeNull();
      expect(offer.claimedOriginalPrice).toBeNull();
      expect(offer.claimedDiscountPct).toBeNull();
    }
  });

  it('dedupes hotels sharing the same hotelId', () => {
    const doubled = { ...tripListingFixture, hotels: [...tripListingFixture.hotels, tripListingFixture.hotels[0]] };
    const withDup = parseDovolena(doubled, REQUEST_URL);
    expect(withDup.length).toBe(offers.length);
  });

  it('returns [] for a response with no hotels array', () => {
    expect(parseDovolena({ hotels: [] }, REQUEST_URL)).toEqual([]);
    expect(parseDovolena({}, REQUEST_URL)).toEqual([]);
  });
});

describe('dovolena source adapter', () => {
  it('is named dovolena and issues bounded requests (3 destinations x page 1)', async () => {
    const jsonMock = vi.fn().mockResolvedValue(tripListingFixture);
    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await dovolena.fetchOffers(ctx);

    expect(dovolena.name).toBe('dovolena');
    expect(jsonMock.mock.calls.length).toBeGreaterThan(0);
    expect(jsonMock.mock.calls.length).toBeLessThanOrEqual(6);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.source === 'dovolena')).toBe(true);
  });

  it('dedupes the same hotel appearing across multiple destination requests', async () => {
    const jsonMock = vi.fn().mockResolvedValue(tripListingFixture);
    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await dovolena.fetchOffers(ctx);
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
    // Same fixture returned for every destination call -> only the first destination's
    // 10 hotels should survive, not 10 * number-of-destinations.
    expect(offers.length).toBe(10);
  });

  it('isolates a per-destination request failure without sinking the whole fetch', async () => {
    const jsonMock = vi.fn().mockRejectedValueOnce(new Error('network blip')).mockResolvedValue(tripListingFixture);
    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await dovolena.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
  });

  it('stops issuing further destination requests on SourceBlockedError but keeps offers already collected', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce(tripListingFixture)
      .mockRejectedValueOnce(new SourceBlockedError(403, 'blocked'));
    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await dovolena.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    expect(jsonMock).toHaveBeenCalledTimes(2);
  });
});
