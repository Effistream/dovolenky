import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  bluestyle,
  parseListingIds,
  parseHotelsResponse,
  mapBluestyleOffers,
  LISTING_PLAN,
  MAX_REQUESTS,
  QUERIES_PER_REQUEST,
  type RawHotel,
} from '../src/sources/bluestyle.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { HttpClient } from '../src/core/http.js';
import type { NormalizedOffer, SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(__dirname, 'fixtures/bluestyle', name), 'utf-8');

// Both fixtures captured live 2026-07-29 with a Chrome UA against POST /graphql.
// routes.json  = the aliased `url(url:)` router lookup for all 16 landing paths.
// listing-batch.json = one batched listing request, aliases q0/q1/q2 =
//   /last-minute/ p1, /exoticka-dovolena/ p1, /premiova-dovolena/ p1 (30 hotels, 120 terms) —
//   deliberately spanning the cheap last-minute pool AND the exotic/premium band that the
//   pre-GraphQL adapter could never reach.
const ROUTES = JSON.parse(read('routes.json')) as unknown;
const LISTING = JSON.parse(read('listing-batch.json')) as unknown;

const LANDING_PATHS = LISTING_PLAN.map((p) => p.path);

function offersFromFixture(adults = 2): NormalizedOffer[] {
  return mapBluestyleOffers(parseHotelsResponse(LISTING), adults);
}

/** Minimal SourceContext whose http.text is a scripted stub; records every call. */
function makeCtx(
  handler: (url: string, init: RequestInit | undefined, call: number) => Promise<string>,
): { ctx: SourceContext; calls: { url: string; body: string }[]; logs: string[] } {
  const calls: { url: string; body: string }[] = [];
  const logs: string[] = [];
  const http = {
    text: (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? '') });
      return handler(url, init, calls.length);
    },
  } as unknown as HttpClient;
  return { ctx: { http, adults: 2, log: (m) => logs.push(m) }, calls, logs };
}

/** Answers the router lookup for real and every listing batch with the listing fixture. */
function happyHandler(): (url: string, init: RequestInit | undefined, call: number) => Promise<string> {
  return async (_url, init) => (String(init?.body ?? '').includes('BsRoutes') ? read('routes.json') : read('listing-batch.json'));
}

describe('parseListingIds', () => {
  it('resolves every landing path to its idThematicHoliday from the aliased router lookup', () => {
    const ids = parseListingIds(ROUTES, LANDING_PATHS);
    expect(ids.size).toBe(LANDING_PATHS.length);
    // Ids are content-managed, hence resolved at runtime rather than hardcoded; these are the
    // values the site served on 2026-07-29 and they anchor the alias ordering (p0 = first path).
    expect(ids.get('/last-minute/')).toBe(101);
    expect(ids.get('/exoticka-dovolena/')).toBe(1);
    expect(ids.get('/premiova-dovolena/')).toBe(38);
  });

  it('accepts params as an already-decoded object as well as the JSON-scalar string', () => {
    const body = {
      data: {
        p0: { httpStatusCode: 200, template: 'THEMATIC_HOLIDAY', params: { idThematicHoliday: 7 } },
      },
    };
    expect(parseListingIds(body, ['/x/']).get('/x/')).toBe(7);
  });

  it('drops paths that stopped being a 200 thematic-holiday page instead of failing the source', () => {
    const body = {
      data: {
        p0: { httpStatusCode: 404 },
        p1: { httpStatusCode: 200, template: 'HOTEL_SEASON', params: '{"idHotel":1}' },
        p2: { httpStatusCode: 200, template: 'THEMATIC_HOLIDAY', params: 'not json' },
        p3: null,
        p4: { httpStatusCode: 200, template: 'THEMATIC_HOLIDAY', params: '{"idThematicHoliday":42}' },
      },
    };
    const ids = parseListingIds(body, ['/a/', '/b/', '/c/', '/d/', '/e/']);
    expect([...ids.entries()]).toEqual([['/e/', 42]]);
  });

  it('returns an empty map for a malformed body rather than throwing', () => {
    expect(parseListingIds(null, ['/a/']).size).toBe(0);
    expect(parseListingIds({ errors: [{ message: 'nope' }] }, ['/a/']).size).toBe(0);
  });
});

describe('parseHotelsResponse', () => {
  it('flattens every aliased thematicHoliday result into one hotel list', () => {
    const hotels = parseHotelsResponse(LISTING);
    // 3 aliases x the site's hard 10-hotels-per-page cap (hotelFilter has no page-size lever).
    expect(hotels.length).toBe(30);
    expect(hotels.every((h) => typeof h.name === 'string')).toBe(true);
  });

  it('keeps the aliases that resolved when part of a batch came back null', () => {
    const body = { data: { q0: null, q1: { hotels: [{ name: 'A' }, { name: 'B' }] }, q2: { hotels: null } } };
    expect(parseHotelsResponse(body).map((h) => h.name)).toEqual(['A', 'B']);
  });
});

describe('mapBluestyleOffers (live fixture)', () => {
  const offers = offersFromFixture();

  it('maps the first offer exactly as the site prices it', () => {
    // Field-checked against the booking engine on 2026-07-29 (searchRoomOfferV3 for this hotel /
    // date / duration returns pricePerPerson 13290, pricePerRoom 26580, board "All Inclusive").
    const first = offers.find((o) => o.title === 'Hotel Pyramisa Beach Resort' && o.departureDate === '2026-08-17');
    expect(first).toBeDefined();
    expect(first!.country).toBe('Egypt');
    expect(first!.locality).toBe('Hurghada');
    expect(first!.stars).toBe(5);
    expect(first!.board).toBe('AI');
    expect(first!.nights).toBe(2);
    expect(first!.pricePerPerson).toBe(13290);
    expect(first!.priceTotal).toBe(26580);
    expect(first!.claimedDiscountPct).toBe(53);
    expect(first!.claimedOriginalPrice).toBe(Math.round(13290 / (1 - 53 / 100)));
    expect(first!.transport).toBe('flight');
    expect(first!.departureAirport).toBe('Praha');
    expect(first!.source).toBe('bluestyle');
    expect(first!.url).toBe(
      'https://www.blue-style.cz/egypt/hurghada/hotel-pyramisa-beach-resort/?date=2026-08-17&duration=2&depCity=2&arrCity=9&airline=Hello%20Jets',
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
      expect(o.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('deduplicates by sourceOfferKey across aliases and across a hotel\'s own terms', () => {
    // The landing pages overlap (a hotel can sit in both /last-minute/ and /exoticka-dovolena/)
    // and a hotel's cheapestTerm is sometimes repeated verbatim inside its own nearestTerms.
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(offers.length).toBeLessThan(30 * 4); // 30 hotels x (cheapest + 3 nearest), minus dupes
  });

  it('emits the nearestTerms alternative dates, not just each hotel\'s cheapest term (finding 3)', () => {
    // The old parser filtered on __typename === 'CheapestTerm' and threw ~3 fully-formed terms
    // per hotel away. One hotel must now yield several distinct departure dates.
    const pyramisa = offers.filter((o) => o.title === 'Hotel Pyramisa Beach Resort');
    expect(pyramisa.length).toBeGreaterThan(1);
    expect(new Set(pyramisa.map((o) => o.departureDate)).size).toBe(pyramisa.length);
    // ...and across the whole fixture there are materially more offers than hotels.
    expect(offers.length).toBeGreaterThan(parseHotelsResponse(LISTING).length * 2);
  });

  it('reaches the exotic/premium price band the /last-minute/-only adapter could not (finding 2)', () => {
    // Old live ceiling was 26 390 CZK and 7 countries, all of them Mediterranean/Egypt.
    const max = Math.max(...offers.map((o) => o.pricePerPerson));
    expect(max).toBeGreaterThan(26390);
    const countries = new Set(offers.map((o) => o.country));
    expect(countries.has('Omán')).toBe(true);
    expect(countries.has('Maledivy')).toBe(true);
  });

  it('fills departureAirport from the term, or from the depCity id in its deep link (finding 4)', () => {
    // computeMatchKey hashes airportNorm ?? '*', so a null here silently blocks every
    // cross-source match for this source.
    const withAirport = offers.filter((o) => o.departureAirport !== null);
    expect(withAirport.length).toBe(offers.length);
    expect(new Set(offers.map((o) => o.departureAirport)).size).toBeGreaterThan(1);
    // cheapestTerm carries no departureCity field at all — only ?depCity=<id> in its URL — so a
    // cheapest-term offer proves the id lookup works.
    const viaUrl = offers.find((o) => o.url.includes('depCity=11'));
    expect(viaUrl?.departureAirport).toBe('Ostrava');
  });

  it('fills priceTotal for a 2-adult scan and leaves it unknown for any other occupancy (finding 6)', () => {
    // Blue Style quotes priceFrom per person for a 2-adult room and the detail page's
    // "Cena celkem" is exactly 2x it; other occupancies are repriced, not scaled.
    for (const o of offers) expect(o.priceTotal).toBe(o.pricePerPerson * 2);
    for (const o of offersFromFixture(3)) expect(o.priceTotal).toBeNull();
  });

  it('tags transport as flight so flight-only profiles see the offers', () => {
    expect(offers.every((o) => o.transport === 'flight')).toBe(true);
  });
});

describe('mapBluestyleOffers (field-level edge cases)', () => {
  const hotel = (over: Partial<RawHotel> = {}): RawHotel => ({
    name: 'Test Hotel',
    url: '/egypt/testville/test-hotel/',
    stars: 'STAR_4',
    countryName: 'Egypt',
    destinationName: 'Testville',
    cheapestTerm: {
      priceFrom: 10000,
      nightCount: 7,
      dayCount: 8,
      percentageDiscount: 20,
      boardingType: 'All Inclusive',
      departureDate: '2026-08-01',
      url: '/egypt/testville/test-hotel/?date=2026-08-01&duration=7&depCity=2&airline=Smartwings',
    },
    ...over,
  });

  it('keeps claimedDiscountPct/claimedOriginalPrice null outside (0, 100) so nothing goes Infinity', () => {
    for (const pct of [0, 100, 150, -5]) {
      const [offer] = mapBluestyleOffers([hotel({ cheapestTerm: { ...hotel().cheapestTerm!, percentageDiscount: pct } })], 2);
      expect(offer!.claimedDiscountPct).toBeNull();
      expect(offer!.claimedOriginalPrice).toBeNull();
    }
    const [ok] = mapBluestyleOffers([hotel({ cheapestTerm: { ...hotel().cheapestTerm!, percentageDiscount: 25, priceFrom: 7500 } })], 2);
    expect(ok!.claimedDiscountPct).toBe(25);
    expect(ok!.claimedOriginalPrice).toBe(Math.round(7500 / (1 - 25 / 100)));
  });

  it('falls back to dayCount - 1 when a term ships a null night count', () => {
    // Live: 9 of 669 nearestTerms come back with nights:null but a usable dayCount. A null
    // nights would drop them out of discount.ts's per-night reference rungs.
    const [offer] = mapBluestyleOffers(
      [hotel({ cheapestTerm: { ...hotel().cheapestTerm!, nightCount: undefined, dayCount: 8 } })],
      2,
    );
    expect(offer!.nights).toBe(7);
  });

  it('learns depCity ids from any nearestTerm in the payload and applies them to cheapest terms', () => {
    const hotels: RawHotel[] = [
      // Unknown id 999 is spelled out on one hotel's nearestTerm...
      hotel({
        name: 'Learner',
        cheapestTerm: null,
        nearestTerms: [
          {
            priceFrom: 9000,
            nights: 4,
            boardingType: 'Polopenze',
            departureDate: '2026-09-01',
            url: '/egypt/testville/learner/?date=2026-09-01&duration=4&depCity=999&airline=X',
            departureCity: 'Karlovy Vary',
            depCity: 999,
          },
        ],
      }),
      // ...and must resolve on another hotel's cheapestTerm, which only has it in the URL.
      hotel({
        name: 'Borrower',
        cheapestTerm: {
          ...hotel().cheapestTerm!,
          url: '/egypt/testville/borrower/?date=2026-08-01&duration=7&depCity=999&airline=X',
        },
      }),
    ];
    const offers = mapBluestyleOffers(hotels, 2);
    expect(offers.find((o) => o.title === 'Borrower')!.departureAirport).toBe('Karlovy Vary');
  });

  it('keeps the same hotel/date/nights/board as separate offers per departure airport', () => {
    // Live 2026-07-29: /letecky-z-brna/ and /letecky-z-ostravy/ list the SAME term at different
    // prices (Pyramisa 2026-08-08 2n = 13 290 from Ostrava, 19 690 from Brno). With departure
    // airport outside sourceOfferKey those collapse into one offer whose surviving price depends
    // on which landing page the site enumerated first — a phantom price change every scan.
    const term = (depCity: number, city: string, priceFrom: number) => ({
      priceFrom,
      nights: 2,
      boardingType: 'All Inclusive',
      departureDate: '2026-08-08',
      url: `/egypt/hurghada/pyramisa/?date=2026-08-08&duration=2&depCity=${depCity}`,
      departureCity: city,
      depCity,
    });
    const fromOstrava = hotel({ name: 'Hotel Pyramisa', cheapestTerm: null, nearestTerms: [term(11, 'Ostrava', 13290)] });
    const fromBrno = hotel({ name: 'Hotel Pyramisa', cheapestTerm: null, nearestTerms: [term(10, 'Brno', 19690)] });

    const offers = mapBluestyleOffers([fromOstrava, fromBrno], 2);
    expect(offers).toHaveLength(2);
    expect(new Set(offers.map((o) => o.sourceOfferKey)).size).toBe(2);
    expect(offers.map((o) => o.pricePerPerson).sort((a, b) => a - b)).toEqual([13290, 19690]);

    // ...and the key must not depend on enumeration order, or the flip comes back as churn.
    const reversed = mapBluestyleOffers([fromBrno, fromOstrava], 2);
    const keyByPrice = (list: NormalizedOffer[]) =>
      Object.fromEntries(list.map((o) => [o.pricePerPerson, o.sourceOfferKey]));
    expect(keyByPrice(reversed)).toEqual(keyByPrice(offers));
  });

  it('still collapses a genuinely identical term repeated across landing pages', () => {
    // The flip side of the key change: the SAME departure must still dedupe, otherwise the
    // heavily-overlapping landing pages would multiply every offer.
    const same = () => hotel({ name: 'Hotel Dupe' });
    expect(mapBluestyleOffers([same(), same()], 2)).toHaveLength(1);
  });

  it('discriminates an unnamed departure city by its raw depCity id', () => {
    // A city id the payload never spells out resolves to a null airport; keying on the id keeps
    // the two departures apart AND keeps the key stable once the name is learned in a later run.
    const t = (depCity: number) => ({
      priceFrom: 11000 + depCity,
      nightCount: 3,
      boardingType: 'All Inclusive',
      departureDate: '2026-08-08',
      url: `/egypt/testville/test-hotel/?date=2026-08-08&duration=3&depCity=${depCity}`,
    });
    const offers = mapBluestyleOffers(
      [hotel({ name: 'Hotel Unnamed', cheapestTerm: t(901) }), hotel({ name: 'Hotel Unnamed', cheapestTerm: t(902) })],
      2,
    );
    expect(offers).toHaveLength(2);
    expect(offers.every((o) => o.departureAirport === null)).toBe(true);
    expect(new Set(offers.map((o) => o.sourceOfferKey)).size).toBe(2);
  });

  it('admits transport unknown when a term names neither a departure city nor an airline', () => {
    const [offer] = mapBluestyleOffers(
      [hotel({ cheapestTerm: { ...hotel().cheapestTerm!, url: '/egypt/testville/test-hotel/?date=2026-08-01' } })],
      2,
    );
    expect(offer!.transport).toBe('unknown');
    expect(offer!.departureAirport).toBeNull();
  });

  it('falls back to the URL slug when countryName is missing, and skips unusable terms', () => {
    const [offer] = mapBluestyleOffers([hotel({ countryName: undefined })], 2);
    expect(offer!.country).toBe('Egypt');
    expect(mapBluestyleOffers([hotel({ name: '  ' })], 2)).toHaveLength(0);
    expect(mapBluestyleOffers([hotel({ cheapestTerm: { ...hotel().cheapestTerm!, priceFrom: 0 } })], 2)).toHaveLength(0);
    expect(mapBluestyleOffers([hotel({ cheapestTerm: { ...hotel().cheapestTerm!, url: undefined }, url: undefined })], 2)).toHaveLength(0);
  });
});

describe('fetchOffers request budget', () => {
  it('keeps LISTING_PLAN inside the hard request cap', () => {
    // run.ts aborts an adapter after 240 s and HttpClient adds a 3 s gap per same-host request,
    // so this guard is what stops a future plan edit from quietly turning into a timeout —
    // which would record the source 'failed' and remove it from the board entirely.
    const pageQueries =
      LISTING_PLAN.reduce((n, p) => n + p.pages, 0) + LISTING_PLAN.filter((p) => p.alsoByDiscount).length;
    const requests = 1 + Math.ceil(pageQueries / QUERIES_PER_REQUEST);
    expect(requests).toBeLessThanOrEqual(MAX_REQUESTS);
  });

  it('spends one request on the router lookup and batches the rest', async () => {
    const { ctx, calls, logs } = makeCtx(happyHandler());
    const offers = await bluestyle.fetchOffers(ctx);

    const pageQueries =
      LISTING_PLAN.reduce((n, p) => n + p.pages, 0) + LISTING_PLAN.filter((p) => p.alsoByDiscount).length;
    expect(calls.length).toBe(1 + Math.ceil(pageQueries / QUERIES_PER_REQUEST));
    expect(calls.length).toBeLessThanOrEqual(MAX_REQUESTS);
    expect(calls.every((c) => c.url === 'https://www.blue-style.cz/graphql')).toBe(true);
    expect(calls[0]!.body).toContain('BsRoutes');
    expect(calls[1]!.body).toContain('BsListing');
    // Every batch but the last carries a full QUERIES_PER_REQUEST aliases — aliasing is the only
    // page-size lever the site offers.
    expect((calls[1]!.body.match(/thematicHoliday\(/g) ?? []).length).toBe(QUERIES_PER_REQUEST);
    expect(offers.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('fetched'))).toBe(true);
  });

  it('asks for the discount-sorted pages only after every landing page got its default pages', async () => {
    const { ctx, calls } = makeCtx(happyHandler());
    await bluestyle.fetchOffers(ctx);
    const bodies = calls.slice(1).map((c) => c.body).join('');
    expect(bodies).toContain('"orderBy":"DISCOUNT"');
    const firstDiscount = bodies.indexOf('"orderBy":"DISCOUNT"');
    const lastDefault = bodies.lastIndexOf('"orderBy":null');
    expect(firstDiscount).toBeGreaterThan(lastDefault);
  });
});

describe('fetchOffers error contract', () => {
  it('rethrows when the router lookup fails, so runScan records failed rather than empty', async () => {
    const { ctx, calls } = makeCtx(async () => {
      throw new Error('boom');
    });
    await expect(bluestyle.fetchOffers(ctx)).rejects.toThrow('boom');
    expect(calls.length).toBe(1);
  });

  it('rethrows when the router lookup resolves nothing usable', async () => {
    const { ctx } = makeCtx(async () => JSON.stringify({ data: { p0: { httpStatusCode: 404 } } }));
    await expect(bluestyle.fetchOffers(ctx)).rejects.toThrow(/no landing page resolved/);
  });

  it('rethrows a GraphQL error body instead of silently reporting zero offers (finding 7)', async () => {
    // The old HTML path turned an occasional degraded response (HTTP 200, empty apolloState) into
    // a silent 0. A GraphQL error must be loud.
    const { ctx } = makeCtx(async (_u, init) =>
      String(init?.body ?? '').includes('BsRoutes')
        ? read('routes.json')
        : JSON.stringify({ errors: [{ message: 'Cannot query field "stars"' }] }),
    );
    await expect(bluestyle.fetchOffers(ctx)).rejects.toThrow(/Cannot query field/);
  });

  it('logs a partial GraphQL failure instead of silently shrinking the source', async () => {
    // data present + errors present = some aliases nulled. parseHotelsResponse keeps the rest, so
    // the run still "succeeds" — with nothing saying why coverage dropped unless we log it.
    const { ctx, logs } = makeCtx(async (_u, init) => {
      if (String(init?.body ?? '').includes('BsRoutes')) return read('routes.json');
      const body = JSON.parse(read('listing-batch.json')) as { data: Record<string, unknown> };
      body.data.q1 = null;
      return JSON.stringify({ ...body, errors: [{ message: 'Timeout resolving thematicHoliday' }] });
    });
    const offers = await bluestyle.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('partial GraphQL error') && l.includes('Timeout resolving'))).toBe(true);
  });

  it('keeps the offers from the batches that worked when one batch fails', async () => {
    const { ctx, calls, logs } = makeCtx(async (_u, init, call) => {
      if (String(init?.body ?? '').includes('BsRoutes')) return read('routes.json');
      if (call === 2) throw new Error('transient 500');
      return read('listing-batch.json');
    });
    const offers = await bluestyle.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(2);
    expect(logs.some((l) => l.includes('transient 500'))).toBe(true);
  });

  it('stops immediately on SourceBlockedError and propagates it when nothing succeeded', async () => {
    const { ctx, calls } = makeCtx(async (_u, init) => {
      if (String(init?.body ?? '').includes('BsRoutes')) return read('routes.json');
      throw new SourceBlockedError(429, 'blocked');
    });
    await expect(bluestyle.fetchOffers(ctx)).rejects.toBeInstanceOf(SourceBlockedError);
    expect(calls.length).toBe(2); // router lookup + the one blocked batch, no further hammering
  });

  it('keeps earlier offers when a block lands after a successful batch', async () => {
    const { ctx, calls } = makeCtx(async (_u, init, call) => {
      if (String(init?.body ?? '').includes('BsRoutes')) return read('routes.json');
      if (call === 2) return read('listing-batch.json');
      throw new SourceBlockedError(429, 'blocked');
    });
    const offers = await bluestyle.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    expect(calls.length).toBe(3);
  });
});
