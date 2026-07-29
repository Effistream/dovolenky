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
// Fresh capture (2026-07-29) taken WITH the pitg/pstg page-size params, from a country the adapter
// did not query before that date. See its own `_note` for the exact URL and what was trimmed.
const pagedFixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/etravel/getsearchresult-paged.json'), 'utf-8'),
);
// The real categories/číselník response, so the budget test below exercises the shipped
// TARGET_COUNTRIES against the names eTravel actually publishes.
const categoriesFixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/etravel/categories.json'), 'utf-8'),
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

  it('reads departureAirport as the IATA code of the outbound leg (was hardcoded null)', () => {
    // The fixture's own flight blocks: PRG×10, OSR×4, BRQ×4, JCL×1, BER×1 — note the Berlin
    // departure, i.e. non-Czech origins were already in the data the adapter was written against.
    expect(offers.every((o) => o.departureAirport !== null)).toBe(true);
    expect(offers[0]!.title).toBe('VILLEA VILLAGE');
    expect(offers[0]!.departureAirport).toBe('PRG');
    expect(offers.find((o) => o.title === 'Piatsa Michalis')!.departureAirport).toBe('OSR');
    const codes = new Set(offers.map((o) => o.departureAirport));
    expect(codes).toEqual(new Set(['PRG', 'OSR', 'BRQ', 'JCL', 'BER']));
  });

  it('reads tourOperator (was hardcoded null) — eTravel resells several operators', () => {
    expect(offers[0]!.tourOperator).toBe('TUI-CZ');
    expect(offers.find((o) => o.title === 'Piatsa Michalis')!.tourOperator).toBe('FISCHER');
    const operators = new Set(offers.map((o) => o.tourOperator));
    expect(operators).toEqual(new Set(['TUI-CZ', 'FISCHER', 'BRENNA', 'INEX', 'EMMA']));
  });

  it('falls back to the city name when fromIATA is missing, and to null with no flight block', () => {
    const base = {
      detailUrl: '/hotely/recko/kreta/test-hotel',
      hotel: { id: 1, name: 'A', breadcrumbs: { country: 'Řecko', destination: 'Kréta' } },
      tour: {
        nightsCount: 7,
        date: { from: '2026-08-01T00:00' },
        price: { adultPrice: 10000, total: 20000, discount: 0, lowestPrice: null },
      },
    };
    const mapped = mapDerTours(
      [
        // No `flight` at all (own-transport/unknown product) -> null, same as before this change.
        base,
        // Airport present but no IATA code: the city name still beats rendering "—" on the board,
        // and core/normalize.ts maps the Czech/neighbouring city names to codes anyway.
        {
          ...base,
          hotel: { ...base.hotel, id: 2 },
          tour: {
            ...base.tour,
            flight: { departure: { segments: [{ airport: { from: 'Vídeň', fromIATA: null } }] } },
          },
        },
        // Malformed (not a 3-letter code) -> city fallback, never a bogus "airport code".
        {
          ...base,
          hotel: { ...base.hotel, id: 3 },
          tour: {
            ...base.tour,
            flight: { departure: { segments: [{ airport: { from: 'Praha', fromIATA: 'PRAHA' } }] } },
          },
        },
      ],
      'etravel',
      'https://www.etravel.cz',
    );
    expect(mapped.map((o) => o.departureAirport)).toEqual([null, 'Vídeň', 'Praha']);
    expect(mapped.every((o) => o.tourOperator === null)).toBe(true);
  });
});

describe('mapDerTours (fresh 2026-07-29 paged capture)', () => {
  const offers = mapDerTours(pagedFixture.tours, 'etravel', 'https://www.etravel.cz');

  it('maps a full page-size response — 40 rows, not the un-paged default of 20', () => {
    expect(pagedFixture.tours.length).toBe(40);
    expect(pagedFixture.toursCount).toBe(516);
    expect(offers.length).toBe(40);
  });

  it('maps Bulharsko — a country the pre-2026-07-29 TARGET_COUNTRIES never queried', () => {
    expect(offers.every((o) => o.country === 'Bulharsko')).toBe(true);
    const cheapest = Math.min(...offers.map((o) => o.pricePerPerson));
    // 5 579 CZK/person is below the 6 902 global minimum the adapter could reach before this
    // country was added — the coverage gap was also a price-floor gap.
    expect(cheapest).toBe(5579);
  });

  it('carries a real departure airport and operator on every row of the fresh capture', () => {
    expect(offers.every((o) => o.departureAirport !== null)).toBe(true);
    expect(offers.every((o) => o.tourOperator !== null)).toBe(true);
    // Bulharsko's cheapest 40 leave from seven airports across four countries — exactly the signal
    // that was invisible while departureAirport was hardcoded null.
    expect(new Set(offers.map((o) => o.departureAirport))).toEqual(
      new Set(['BTS', 'BUD', 'OSR', 'BRQ', 'PRG', 'KTW', 'PED']),
    );
    expect(new Set(offers.map((o) => o.tourOperator))).toEqual(
      new Set(['FISCHER', 'TUI-CZ', 'ALEXANDRIA', 'EXIM Tours']),
    );
  });

  it('still null-guards the Omnibus lowestPrice (absent on this endpoint)', () => {
    expect(offers.every((o) => o.omnibusLowestPrice === null)).toBe(true);
  });
});

describe('etravel source adapter', () => {
  it('is named etravel and queries only the target countries the číselník actually lists', async () => {
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

  it('asks for a page size — without pitg/pstg the endpoint silently caps each country at 20', async () => {
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce({
        categories: [{ destinations: [{ id: 63002, name: 'Bulharsko', destinationIds: '63483|63484' }] }],
      })
      .mockResolvedValue({ tours: pagedFixture.tours, toursCount: pagedFixture.toursCount });

    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await etravel.fetchOffers(ctx);
    expect(offers.length).toBe(40);

    const discoveryUrl = jsonMock.mock.calls[0]![0] as string;
    expect(discoveryUrl).toBe('https://www.etravel.cz/api/searchapi/getsearchresult?tt=1');

    const searchUrl = new URL(jsonMock.mock.calls[1]![0] as string);
    expect(searchUrl.searchParams.get('pitg')).toBe('40');
    expect(searchUrl.searchParams.get('pstg')).toBe('0');
    // The rest of the query must not have drifted: same destination ids, 60-day window, 7-14
    // nights, 2 adults. (`dd` is "today", so only its shape is asserted.)
    expect(searchUrl.searchParams.get('d')).toBe('63483|63484');
    expect(searchUrl.searchParams.get('nn')).toBe('7|8|9|10|11|12|13|14');
    expect(searchUrl.searchParams.get('ac1')).toBe('2');
    expect(searchUrl.searchParams.get('dd')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dd = new Date(`${searchUrl.searchParams.get('dd')}T00:00:00Z`);
    const rd = new Date(`${searchUrl.searchParams.get('rd')}T00:00:00Z`);
    expect((rd.getTime() - dd.getTime()) / 86_400_000).toBe(60);
  });

  it('stays inside the request budget when every target country resolves', async () => {
    // Driven by the REAL categories response, so this also fails if a TARGET_COUNTRIES entry is
    // misspelled relative to eTravel's číselník (it would silently skip in production instead).
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce(categoriesFixture)
      .mockResolvedValue({ tours: [], toursCount: 0 });

    const log = vi.fn();
    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log,
    };

    await etravel.fetchOffers(ctx);

    // src/core/run.ts aborts an adapter at 240 s and HttpClient enforces a 3 s per-host gap, so the
    // request count is the run's cost. MAX_REQUESTS in etravel.ts is 40; blowing it fails the whole
    // source (inventory deactivated), which is worse than partial coverage — hence a hard assert
    // rather than a comment. 25 = 1 discovery + 24 countries.
    expect(jsonMock.mock.calls.length).toBe(25);
    expect(jsonMock.mock.calls.length).toBeLessThanOrEqual(40);
    // Every target name must be present in the real číselník: no "no destination ids found" skips.
    const skips = log.mock.calls.filter((c) => String(c[0]).includes('no destination ids found'));
    expect(skips).toEqual([]);
    // …and every destination query must carry the page-size params.
    for (const [url] of jsonMock.mock.calls.slice(1) as [string][]) {
      expect(new URL(url).searchParams.get('pitg')).toBe('40');
    }
  });

  it('stops starting destinations once the wall-clock budget is nearly spent', async () => {
    // The request COUNT is not what bounds this adapter — eTravel's per-destination server time
    // swung 0.3-12 s across runs on 2026-07-29 (three full runs: 80 s, 160 s, 179 s). Only the
    // wall-clock guard keeps a slow day from hitting run.ts's 240 s abort, which would record the
    // source 'failed' and deactivate its whole inventory. Simulated here by advancing a fake clock
    // 30 s per request: RUN_BUDGET_MS 200 s / MIN_REQUEST_BUDGET_MS 20 s means we may start a
    // destination while >= 20 s remain, so discovery + 6 destinations run and the 7th is dropped.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-29T06:00:00Z'));
      const jsonMock = vi
        .fn()
        .mockImplementationOnce(async () => {
          vi.advanceTimersByTime(30_000);
          return categoriesFixture;
        })
        .mockImplementation(async () => {
          vi.advanceTimersByTime(30_000);
          return { tours: [], toursCount: 0 };
        });

      const log = vi.fn();
      const ctx: SourceContext = {
        http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
        adults: 2,
        log,
      };

      await etravel.fetchOffers(ctx);

      expect(jsonMock).toHaveBeenCalledTimes(7);
      // It must be the DEADLINE that stopped us, not the 40-request structural cap.
      const stops = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('elapsed, stopping'));
      expect(stops).toHaveLength(1);
      expect(stops[0]).toContain('210s elapsed');
      // Coverage degrades from the TAIL of TARGET_COUNTRIES, so the profile countries queried
      // first survive a slow day and the board-only extras are what gets dropped.
      const queried = (jsonMock.mock.calls.slice(1) as [string][]).map(
        ([url]) => new URL(url).searchParams.get('d')!,
      );
      const idsFor = (name: string) =>
        categoriesFixture.categories
          .flatMap((c: { destinations: { name: string; destinationIds: string }[] }) => c.destinations)
          .find((d: { name: string }) => d.name === name)!.destinationIds;
      expect(queried[0]).toBe(idsFor('Španělsko'));
      expect(queried).not.toContain(idsFor('Tunisko'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives each destination request an abort signal, so retries cannot outlive the budget', async () => {
    // HttpClient retries a failing request 3× at up to 25 s each; without a caller-supplied signal
    // a single hung destination costs ~80 s AFTER the last deadline check passed, which is how a
    // "175 s" budget can finish at 255 s and trip the 240 s abort anyway.
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce({
        categories: [{ destinations: [{ id: 63002, name: 'Bulharsko', destinationIds: '63483' }] }],
      })
      .mockResolvedValue({ tours: [], toursCount: 0 });

    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    await etravel.fetchOffers(ctx);

    const init = jsonMock.mock.calls[1]![1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init!.signal!.aborted).toBe(false);
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

    // The rethrown error must still BE a SourceBlockedError, not a re-wrapped plain Error:
    // run.ts brands the run with BLOCKED_PREFIX via `err instanceof SourceBlockedError`, and that
    // marker is what arms the 24h backoff. Re-wrapping would silently disarm it.
    await expect(etravel.fetchOffers(ctx)).rejects.toBeInstanceOf(SourceBlockedError);
    // …and it must STOP, not keep hammering a site that is actively blocking us. Without this
    // assertion the test passes even with the `break` removed (the mock rejects every call, so the
    // successCount===0 rethrow fires either way): 1 discovery + exactly 1 destination attempt.
    expect(jsonMock).toHaveBeenCalledTimes(2);
  });

  it('a block AFTER a success stops further requests but keeps the offers already collected', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
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
      .mockResolvedValueOnce({ tours: searchResultFixture.tours.slice(0, 3), toursCount: 3 })
      .mockRejectedValue(new SourceBlockedError(429, 'blocked'));

    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    // Partial coverage beats failing the source: what Řecko yielded is real, still-bookable
    // inventory, and returning it keeps runScan from flipping the whole source's offers inactive.
    const offers = await etravel.fetchOffers(ctx);
    expect(offers.length).toBe(3);
    // 1 discovery + Řecko (ok) + Turecko (blocked) — Egypt is never attempted.
    expect(jsonMock).toHaveBeenCalledTimes(3);
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
