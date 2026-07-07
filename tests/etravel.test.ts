import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mapDerTours } from '../src/sources/der.js';
import { etravel } from '../src/sources/etravel.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const searchResultFixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/etravel/getsearchresult.json'), 'utf-8'),
);

describe('mapDerTours (etravel fixture)', () => {
  const offers = mapDerTours(searchResultFixture.tours, 'etravel', 'https://www.etravel.cz');

  it('maps every tour in the fixture to an offer (no silent drops)', () => {
    expect(searchResultFixture.tours.length).toBe(20);
    expect(offers.length).toBe(20);
  });

  it('maps the first offer (VILLEA VILLAGE) with hardcoded real values', () => {
    const first = offers[0]!;
    expect(first.source).toBe('etravel');
    expect(first.title).toBe('VILLEA VILLAGE');
    expect(first.country).toBe('Řecko');
    expect(first.locality).toBe('Kréta');
    expect(first.pricePerPerson).toBe(9796); // adultPrice 9796.2 rounded
    expect(first.priceTotal).toBe(19592); // total 19592.4 rounded
    expect(first.departureDate).toBe('2026-08-26');
    expect(first.nights).toBe(7);
    // no discount on this tour -> Omnibus lowestPrice is null and no claimed price
    expect(first.omnibusLowestPrice).toBeNull();
    expect(first.claimedOriginalPrice).toBeNull();
    expect(first.claimedDiscountPct).toBeNull();
  });

  it('computes claimedOriginalPrice/claimedDiscountPct from a discounted tour (Piatsa Michalis)', () => {
    // Empirical finding: `tour.price.discount` is an absolute CZK amount on the TOTAL
    // price (for all adults combined), not per person. Verified against the fixture:
    // adultPrice=9990, total=19980 (=2*adultPrice), discount=28280.
    // originalTotal = total + discount = 48260 -> per-person = 24130.
    const piatsa = offers.find((o) => o.title === 'Piatsa Michalis');
    expect(piatsa).toBeDefined();
    expect(piatsa!.pricePerPerson).toBe(9990);
    expect(piatsa!.priceTotal).toBe(19980);
    expect(piatsa!.claimedOriginalPrice).toBe(24130);
    expect(piatsa!.claimedDiscountPct).toBe(59);
  });

  it('handles null lowestPrice safely (Omnibus field absent in this fixture snapshot)', () => {
    // Empirical finding: across all sampled destinations/pages (Řecko, Turecko, Egypt,
    // Tunisko, Kypr, Itálie — hundreds of tours, many discounted), `tour.price.lowestPrice`
    // was consistently null on the search-listing endpoint. The field is real (see spec
    // §3 row 8) but appears to only populate for eTravel's own bedbank inventory under
    // conditions not observed in this snapshot. We null-guard rather than assume a shape.
    for (const offer of offers) {
      expect(offer.omnibusLowestPrice === null || typeof offer.omnibusLowestPrice === 'number').toBe(true);
    }
    expect(offers.every((o) => o.omnibusLowestPrice === null)).toBe(true);
  });

  it('round-trips a non-null omnibusLowestPrice when present in the data', () => {
    const synthetic = [
      {
        detailUrl: '/hotely/recko/kreta/test-hotel',
        hotel: {
          id: 999,
          name: 'TEST HOTEL',
          breadcrumbs: { country: 'Řecko', destination: 'Kréta' },
        },
        tour: {
          nightsCount: 7,
          date: { from: '2026-08-01T00:00' },
          price: { adultPrice: 10000, total: 20000, discount: 4000, lowestPrice: 17777.6 },
        },
      },
    ];
    const [offer] = mapDerTours(synthetic, 'etravel', 'https://www.etravel.cz');
    expect(offer!.omnibusLowestPrice).toBe(17778); // rounded
  });

  it('enforces invariants: positive price, absolute url, correct source tag', () => {
    for (const offer of offers) {
      expect(offer.pricePerPerson).toBeGreaterThan(0);
      expect(offer.url.startsWith('https://www.etravel.cz')).toBe(true);
      expect(offer.source).toBe('etravel');
      expect(offer.sourceOfferKey.length).toBeGreaterThan(0);
    }
  });

  it('produces a real country for every offer (never null/generic)', () => {
    for (const offer of offers) {
      expect(offer.country).toBeTruthy();
      expect(offer.country).not.toBe('unknown');
    }
  });

  it('dedupes offers sharing the same hotel/date/nights key', () => {
    const duplicated = [...searchResultFixture.tours, searchResultFixture.tours[0]];
    const withDup = mapDerTours(duplicated, 'etravel', 'https://www.etravel.cz');
    expect(withDup.length).toBe(offers.length);
  });
});

describe('etravel source adapter', () => {
  it('is named etravel and issues bounded requests (getfilter/categories + up to 3 destination queries)', async () => {
    const jsonMock = vi
      .fn()
      // 1st call: categories discovery (tt=1, no destination filter)
      .mockResolvedValueOnce({
        categories: [
          {
            destinations: [
              { id: 63064, name: 'Řecko', destinationIds: '1|2' },
              { id: 63184, name: 'Turecko', destinationIds: '3|4' },
              { id: 63042, name: 'Egypt', destinationIds: '5|6' },
            ],
          },
        ],
      })
      // destination queries
      .mockResolvedValueOnce({ tours: searchResultFixture.tours, toursCount: searchResultFixture.toursCount })
      .mockResolvedValueOnce({ tours: [], toursCount: 0 })
      .mockResolvedValueOnce({ tours: [], toursCount: 0 });

    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await etravel.fetchOffers(ctx);

    expect(etravel.name).toBe('etravel');
    expect(jsonMock).toHaveBeenCalledTimes(4);
    expect(offers.length).toBe(20);
    expect(offers.every((o) => o.source === 'etravel')).toBe(true);
  });

  it('rethrows a total discovery failure (so runScan records it failed, not empty)', async () => {
    const jsonMock = vi.fn().mockRejectedValue(new Error('discovery down'));

    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    await expect(etravel.fetchOffers(ctx)).rejects.toThrow('discovery down');
    // Only the single discovery call was attempted; no destination queries followed.
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('isolates a per-destination request failure without sinking the whole fetch', async () => {
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce({
        categories: [
          {
            destinations: [
              { id: 63064, name: 'Řecko', destinationIds: '1|2' },
              { id: 63184, name: 'Turecko', destinationIds: '3|4' },
              { id: 63042, name: 'Egypt', destinationIds: '5|6' },
            ],
          },
        ],
      })
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ tours: searchResultFixture.tours.slice(0, 2), toursCount: 2 })
      .mockResolvedValueOnce({ tours: [], toursCount: 0 });

    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await etravel.fetchOffers(ctx);
    expect(offers.length).toBe(2);
  });

  it('rethrows when the FIRST destination query is blocked before any success (backoff must engage)', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce({
        categories: [
          {
            destinations: [
              { id: 63064, name: 'Řecko', destinationIds: '1|2' },
              { id: 63184, name: 'Turecko', destinationIds: '3|4' },
            ],
          },
        ],
      })
      .mockRejectedValue(new SourceBlockedError(403, 'blocked'));

    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    await expect(etravel.fetchOffers(ctx)).rejects.toThrow('blocked');
  });

  it('rethrows when ALL destination queries fail generically (total failure, not empty market)', async () => {
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce({
        categories: [
          {
            destinations: [
              { id: 63064, name: 'Řecko', destinationIds: '1|2' },
              { id: 63184, name: 'Turecko', destinationIds: '3|4' },
            ],
          },
        ],
      })
      .mockRejectedValue(new Error('all destinations down'));

    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    await expect(etravel.fetchOffers(ctx)).rejects.toThrow('all destinations down');
  });
});
