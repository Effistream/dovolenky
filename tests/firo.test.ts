import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { firo } from '../src/sources/firo.js';
import {
  parseCesysDates,
  parseAccommodationsSitemap,
  parseHotelDetail,
  parseHotelNameFromDetail,
  planDatesListRequests,
  MAX_DATES_LIST_REQUESTS,
  type CesysMaps,
  type DatesListQuery,
} from '../src/sources/cesys.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures/firo', name), 'utf-8');
}

// Live fixtures captured 2026-07-07 (Chrome UA, ≥3s per-host gap) — see task-35 report / the
// header comment in src/sources/cesys.ts for provenance and the four verification points.
//  - dates-list-exotika.json: POST dates-list?client_id=12352 with country_id = the 12 exotic
//    ids and the +270d window. Under price-asc sort the whole page collapses onto the single
//    cheapest exotic hotel (master_id 6564, Spojené arabské emiráty, Coral Travel) — real API
//    behaviour, mirrors dovolenkovani's "one cheap hotel dominates" finding.
//  - dates-list-maldives.json: POST with country_id:["131"] — every row comes back country 131,
//    proving the server-side country_id filter (verification point b).
//  - countries.json: GET mapping/countries?client_id=12352 (198 = SAE, 131 = Maledivy).
//  - accommodations.xml: FIRO's sitemap with the extra /detail-zajezdu/<country>/<slug>/<code>
//    segment (verification point c).
//  - detail-6564.html: trimmed detail page reached via the 2-segment detail-redirect (point d).
//  - dates-list-exotika-band-42k.json: the SAME exotika query narrowed to the 42,000-62,000 CZK
//    price band (captured 2026-07-29, rows trimmed to <=3 per country). This is the fix in one
//    file: the unbanded query above collapses onto one Dubai hotel, while this band returns five
//    countries — SAE, Thajsko, Dominikánská republika, Kapverdy, Mauricius — and eight hotels.
const exotikaFixture = JSON.parse(loadFixture('dates-list-exotika.json'));
const exotikaBand42kFixture = JSON.parse(loadFixture('dates-list-exotika-band-42k.json'));
const maldivesFixture = JSON.parse(loadFixture('dates-list-maldives.json'));
const countriesFixture = JSON.parse(loadFixture('countries.json'));
const accommodationsXml = loadFixture('accommodations.xml');
const sitemapIndexXml = loadFixture('sitemap-index.xml');
const detailFixture = loadFixture('detail-6564.html');

const RESOLVED_HOTEL_NAME = 'Sheraton Jumeirah Beach Resort & Towers';
// The 12 exotic CESYS country ids the exotika query filters on (spec §16.1 row 11).
const EXOTIKA_COUNTRY_IDS = ['220', '131', '138', '198', '46', '142', '192', '215', '219', '112', '239', '102'];

const firoMaps: CesysMaps = {
  hotels: new Map(),
  countries: countriesFixture,
  source: 'firo',
  fallbackUrl: 'https://www.firotravel.cz/vyhledavani-zajezdu/',
  detailUrlFor: (masterId) => `https://www.firotravel.cz/detail-zajezdu/x/${masterId}a`,
};

describe('firo pure parsing over live fixtures', () => {
  it('parseAccommodationsSitemap handles FIRO\'s /detail-zajezdu/<country>/<slug>/<code> shape', () => {
    const map = parseAccommodationsSitemap(accommodationsXml);
    expect(map.size).toBe(168);
    // The slug is the last segment before the code, NOT the leading country segment.
    expect(map.get(4)?.name).toBe('Porto Elounda Golf Spa Resort');
    expect(map.get(4)?.url).toBe('https://www.firotravel.cz/detail-zajezdu/recko/porto-elounda-golf-spa-resort/4a');
    expect(map.get(7)?.name).toBe('Nana Royal Premium');
    expect(map.get(246)?.name).toBe('Steigenberger Coraya Beach');
  });

  it('parseHotelNameFromDetail extracts the ld+json LodgingBusiness name from a FIRO detail page', () => {
    expect(parseHotelNameFromDetail(detailFixture)).toBe(RESOLVED_HOTEL_NAME);
  });

  it('parses exotic offers with source "firo" and resolves SAE via the countries mapping', () => {
    const offers = parseCesysDates(exotikaFixture, firoMaps);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.source === 'firo')).toBe(true);
    expect(offers.every((o) => o.country === 'Spojené arabské emiráty')).toBe(true);
    expect(offers.every((o) => o.transport === 'flight')).toBe(true);
    expect(offers.every((o) => o.pricePerPerson > 0)).toBe(true);
    expect(offers.some((o) => o.tourOperator === 'Coral Travel')).toBe(true);
  });

  it('the country_id:["131"] fixture is genuinely Maldives-only (server-side filter evidence)', () => {
    const offers = parseCesysDates(maldivesFixture, firoMaps);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.country === 'Maledivy')).toBe(true);
    expect(offers.every((o) => o.source === 'firo')).toBe(true);
  });
});

describe('firo source adapter', () => {
  function makeCtx(
    textImpl: (url?: string) => Promise<string>,
    jsonImpl: (url?: string, init?: RequestInit) => Promise<unknown>,
  ): { ctx: SourceContext; textMock: ReturnType<typeof vi.fn>; jsonMock: ReturnType<typeof vi.fn> } {
    const textMock = vi.fn().mockImplementation(textImpl);
    const jsonMock = vi.fn().mockImplementation(jsonImpl);
    const ctx: SourceContext = {
      http: { text: textMock, json: jsonMock } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };
    return { ctx, textMock, jsonMock };
  }

  function standardCtx() {
    return makeCtx(
      async (url?: string) => {
        if (url === 'https://www.firotravel.cz/sitemap.xml') return sitemapIndexXml;
        if (url && /\/accommodations\.xml$/.test(url)) return accommodationsXml;
        if (url && /\/am-accommodations\.xml$/.test(url)) return '<?xml version="1.0"?><urlset></urlset>';
        if (url === 'https://www.firotravel.cz/detail-zajezdu/x/6564a') return detailFixture;
        // Any other detail-page lookup: no parseable name -> keeps the "Hotel <id>" fallback.
        return '<html><body>no name</body></html>';
      },
      async (_url?: string, init?: RequestInit) => {
        if (init === undefined) return countriesFixture; // mapping/countries GET
        return exotikaFixture; // every dates-list POST
      },
    );
  }

  it('is named firo and yields firo-tagged exotic offers', async () => {
    const { ctx } = standardCtx();
    const offers = await firo.fetchOffers(ctx);
    expect(firo.name).toBe('firo');
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.source === 'firo')).toBe(true);
    expect(offers.some((o) => o.country === 'Spojené arabské emiráty')).toBe(true);
  });

  it('resolves master_id 6564 to its real name via the default (dovolenkovani-shape) detail redirect', async () => {
    const { ctx } = standardCtx();
    const offers = await firo.fetchOffers(ctx);
    // 6564 is not in the sitemap fixture -> resolved through GET /detail-zajezdu/x/6564a.
    expect(offers.some((o) => o.title === RESOLVED_HOTEL_NAME)).toBe(true);
    expect(offers.some((o) => o.title === 'Hotel 6564')).toBe(false);
  });

  it('issues exactly one dates-list body carrying country_id (the exotika query), with the 12 exotic ids', async () => {
    const { ctx, jsonMock } = standardCtx();
    await firo.fetchOffers(ctx);

    const postBodies = jsonMock.mock.calls
      .filter((call) => call[1] !== undefined)
      .map((call) => JSON.parse((call[1] as RequestInit).body as string));
    // 3 profiles × their price bands = 3 léto-moře + 3 last-minute + 5 exotika = 11 bodies.
    expect(postBodies.length).toBe(11);

    const withCountry = postBodies.filter((b) => b.country_id !== undefined);
    // One per exotika band, each carrying the full 12-id exotic list.
    expect(withCountry.length).toBe(5);
    for (const body of withCountry) expect(body.country_id).toEqual(EXOTIKA_COUNTRY_IDS);

    // The non-exotika queries must NOT carry a country_id at all (catalogue-wide).
    expect(postBodies.filter((b) => b.country_id === undefined).length).toBe(6);
  });

  it('never sorts by "discount desc" (that returns HTTP 500 on CESYS) — every query uses the safe price/date sort', async () => {
    const { ctx, jsonMock } = standardCtx();
    await firo.fetchOffers(ctx);

    const postBodies = jsonMock.mock.calls
      .filter((call) => call[1] !== undefined)
      .map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(postBodies.length).toBeGreaterThan(0);
    for (const body of postBodies) {
      expect(Array.isArray(body.sort)).toBe(true);
      expect(body.sort).toEqual(['price asc', 'date_from asc']);
      expect(body.sort.some((s: string) => /discount/i.test(s))).toBe(false);
    }
  });

  it('sends every dates-list request as POST with a JSON content-type', async () => {
    const { ctx, jsonMock } = standardCtx();
    await firo.fetchOffers(ctx);

    const datesListCalls = jsonMock.mock.calls.filter((call) => call[1] !== undefined);
    expect(datesListCalls.length).toBe(11);
    for (const call of datesListCalls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      // client_id/customer_id must be FIRO's, on the URL and in the body.
      expect(call[0]).toContain('client_id=12352');
      const body = JSON.parse(init.body as string);
      expect(body.client_id).toBe('12352');
      expect(body.customer_id).toBe('3593');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The price ladder (audit fix, 2026-07-29). The shipped single `price:{0,999999}` exotika query
// came back as 30 rows of ONE Dubai hotel out of 12 requested countries; bounding the price
// window on both ends and issuing one request per band is what makes the long-haul band arrive.
// ---------------------------------------------------------------------------------------------

describe('firo price ladder', () => {
  function postBodiesOf(jsonMock: ReturnType<typeof vi.fn>): Record<string, any>[] {
    return jsonMock.mock.calls
      .filter((call) => call[1] !== undefined)
      .map((call) => JSON.parse((call[1] as RequestInit).body as string));
  }

  function ladderCtx(adults = 2) {
    const jsonMock = vi.fn().mockImplementation(async (_url?: string, init?: RequestInit) =>
      init === undefined ? countriesFixture : exotikaBand42kFixture,
    );
    const ctx: SourceContext = {
      http: {
        text: vi.fn().mockImplementation(async () => '<html><body>no name</body></html>'),
        json: jsonMock,
      } as unknown as SourceContext['http'],
      adults,
      log: vi.fn(),
    };
    return { ctx, jsonMock };
  }

  it('never issues an unbounded price window — every band is closed at BOTH ends', async () => {
    const { ctx, jsonMock } = ladderCtx();
    await firo.fetchOffers(ctx);

    const bodies = postBodiesOf(jsonMock);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(typeof body.price.from).toBe('number');
      expect(typeof body.price.to).toBe('number');
      expect(body.price.to).toBeGreaterThan(body.price.from);
      // 999999 was the old catch-all ceiling; it is exactly the shape that breaks the server's
      // price-asc head, so no band may ever use it again.
      expect(body.price.to).toBeLessThan(999999);
    }
  });

  it('lays the bands of each profile end to end, ascending and non-overlapping', async () => {
    const { ctx, jsonMock } = ladderCtx();
    await firo.fetchOffers(ctx);

    const byProfile = new Map<string, { from: number; to: number }[]>();
    for (const body of postBodiesOf(jsonMock)) {
      // Profiles are distinguishable by their date window + country filter.
      const key = `${body.date.from}..${body.date.to}|${(body.country_id ?? []).join(',')}`;
      const bands = byProfile.get(key) ?? [];
      bands.push({ from: body.price.from, to: body.price.to });
      byProfile.set(key, bands);
    }
    expect(byProfile.size).toBe(3); // léto-moře, last-minute, exotika

    for (const bands of byProfile.values()) {
      expect(bands.length).toBeGreaterThanOrEqual(3);
      expect(bands[0]!.from).toBe(0); // the cheapest band always starts at zero
      for (let i = 1; i < bands.length; i += 1) {
        expect(bands[i]!.from).toBeGreaterThanOrEqual(bands[i - 1]!.to);
      }
    }
  });

  it('gives the exotika profile a band above 40k CZK — the long-haul band the single query never reached', async () => {
    const { ctx, jsonMock } = ladderCtx();
    await firo.fetchOffers(ctx);

    const exotika = postBodiesOf(jsonMock).filter((b) => b.country_id !== undefined);
    expect(exotika.some((b) => b.price.from >= 40000)).toBe(true);
    // Long-haul burns 2 nights on flights, so duration.from must be 8 (not the short-haul 7) for
    // the minNights:6 floor to keep the rows instead of discarding them.
    for (const body of exotika) expect(body.duration.from).toBe(8);
  });

  it('honours ctx.adults instead of hardcoding a 2-adult room', async () => {
    const { ctx, jsonMock } = ladderCtx(3);
    await firo.fetchOffers(ctx);
    for (const body of postBodiesOf(jsonMock)) expect(body.composition.adults).toBe(3);
  });

  it('asks for the LOCAL calendar date, not the UTC one (a 00:30 CEST scan must not start yesterday)', async () => {
    const { ctx, jsonMock } = ladderCtx();
    await firo.fetchOffers(ctx);

    const now = new Date();
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (const body of postBodiesOf(jsonMock)) expect(body.date.from).toBe(localToday);
  });
});

describe('dates-list request budget', () => {
  const band = { from: 0, to: 1000 };

  it('caps the plan at MAX_DATES_LIST_REQUESTS and reports what it dropped', () => {
    const greedy: DatesListQuery[] = [
      {
        label: 'greedy',
        fromDays: 0,
        toDays: 60,
        durationFrom: 7,
        durationTo: 22,
        priceBands: Array.from({ length: MAX_DATES_LIST_REQUESTS + 5 }, (_, i) => ({ from: i * 1000, to: (i + 1) * 1000 })),
      },
    ];
    const { plan, dropped } = planDatesListRequests(greedy);
    expect(plan.length).toBe(MAX_DATES_LIST_REQUESTS);
    expect(dropped).toBe(5);
  });

  it('leaves a plan that already fits untouched, in configured order', () => {
    const queries: DatesListQuery[] = [
      { label: 'a', fromDays: 0, toDays: 1, durationFrom: 1, durationTo: 2, priceBands: [band, { from: 1000, to: 2000 }] },
      { label: 'b', fromDays: 0, toDays: 2, durationFrom: 1, durationTo: 2, priceBands: [band] },
    ];
    const { plan, dropped } = planDatesListRequests(queries);
    expect(dropped).toBe(0);
    expect(plan.map((p) => `${p.query.label}:${p.band.from}`)).toEqual(['a:0', 'a:1000', 'b:0']);
  });

  it("firo's own ladder fits the budget with headroom (a live run must stay well under the 240s adapter timeout)", async () => {
    const jsonMock = vi.fn().mockImplementation(async (_url?: string, init?: RequestInit) =>
      init === undefined ? countriesFixture : exotikaBand42kFixture,
    );
    const ctx: SourceContext = {
      http: {
        text: vi.fn().mockImplementation(async () => '<html><body>no name</body></html>'),
        json: jsonMock,
      } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };
    await firo.fetchOffers(ctx);
    const datesListCalls = jsonMock.mock.calls.filter((call) => call[1] !== undefined).length;
    expect(datesListCalls).toBeLessThanOrEqual(MAX_DATES_LIST_REQUESTS);
    expect(datesListCalls).toBeLessThan(MAX_DATES_LIST_REQUESTS); // headroom, not right at the cap
  });
});

describe('exotika band fixture — field mapping over the price-banded response', () => {
  const offers = parseCesysDates(exotikaBand42kFixture, firoMaps);

  it('delivers five exotic countries where the unbanded query delivered one', () => {
    const banded = new Set(offers.map((o) => o.country));
    const unbanded = new Set(parseCesysDates(exotikaFixture, firoMaps).map((o) => o.country));
    expect([...unbanded]).toEqual(['Spojené arabské emiráty']);
    expect(banded).toContain('Thajsko');
    expect(banded).toContain('Kapverdy');
    expect(banded).toContain('Mauricius');
    expect(banded).toContain('Dominikánská republika');
    expect(banded.size).toBe(5);
  });

  it('lands the whole band above 40k CZK — the price range the old query could not reach', () => {
    expect(Math.min(...offers.map((o) => o.pricePerPerson))).toBeGreaterThanOrEqual(42000);
    // The unbanded exotika page topped out around 22.5k.
    expect(Math.max(...parseCesysDates(exotikaFixture, firoMaps).map((o) => o.pricePerPerson))).toBeLessThan(30000);
  });

  it('maps a Mauricius row field by field (verified against the live row)', () => {
    const mauricius = offers.find((o) => o.country === 'Mauricius')!;
    expect(mauricius.title).toBe('Hotel 317350');
    expect(mauricius.pricePerPerson).toBe(42001); // price_from.CZK 42000.7, rounded
    expect(mauricius.departureDate).toBe('2026-09-01');
    expect(mauricius.nights).toBe(6);
    expect(mauricius.board).toBe('BB'); // "Snídaně"
    expect(mauricius.departureAirport).toBe('PRG');
    expect(mauricius.transport).toBe('flight');
    expect(mauricius.tourOperator).toBe('TUI');
    // Honest nulls: CESYS returns price_total and discount_percent null on every row.
    expect(mauricius.priceTotal).toBeNull();
    expect(mauricius.claimedDiscountPct).toBeNull();
    expect(mauricius.claimedOriginalPrice).toBeNull();
  });

  it('keeps two operators selling the identical hotel/date/nights/board/airport as two offers', () => {
    // master 179238 (Kapverdy) comes back twice in the live band: same 2027-03-19 / 7 nights /
    // All inclusive / PRG, once from Fischer CK and once from Eximtours. The old sourceOfferKey
    // omitted the operator, so the second one was silently dropped as a duplicate.
    const kapverdy = offers.filter((o) => o.country === 'Kapverdy');
    expect(kapverdy.length).toBe(2);
    expect(new Set(kapverdy.map((o) => o.tourOperator))).toEqual(new Set(['Fischer CK', 'Eximtours']));
    expect(kapverdy[0]!.sourceOfferKey).not.toBe(kapverdy[1]!.sourceOfferKey);
  });

  it('keeps two departure airports for the same hotel/date/nights/board as two offers', () => {
    const sameButForAirport = {
      status: 'success',
      data: {
        results: 2,
        more_exists: false,
        dates: [
          { master_id: 6564, date_from: '2026-09-01', duration_night: 6, boarding: 'Snídaně', boarding_id: 2, transport_id: 1, airport_code: 'PRG', price_from: { CZK: 21440 }, country: 198, rating: 5, tour_operator: { name: 'Coral Travel' } },
          { master_id: 6564, date_from: '2026-09-01', duration_night: 6, boarding: 'Snídaně', boarding_id: 2, transport_id: 1, airport_code: 'VIE', price_from: { CZK: 22455 }, country: 198, rating: 5, tour_operator: { name: 'Coral Travel' } },
        ],
      },
    };
    const both = parseCesysDates(sameButForAirport, firoMaps);
    expect(both.length).toBe(2);
    expect(both.map((o) => o.departureAirport)).toEqual(['PRG', 'VIE']);
    expect(both[0]!.sourceOfferKey).not.toBe(both[1]!.sourceOfferKey);
  });

  it('gives every offer a working per-hotel URL, never the generic search form', () => {
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(offer.url).not.toBe('https://www.firotravel.cz/vyhledavani-zajezdu/');
      expect(offer.url).toMatch(/^https:\/\/www\.firotravel\.cz\/detail-zajezdu\/x\/\d+a$/);
    }
    // …and falls back to the search form only when the storefront supplies no detail-path shape.
    const [noDetailShape] = parseCesysDates(exotikaBand42kFixture, { ...firoMaps, detailUrlFor: undefined });
    expect(noDetailShape!.url).toBe('https://www.firotravel.cz/vyhledavani-zajezdu/');
  });
});

describe('parseHotelDetail', () => {
  it('reads name, canonical URL and locality from the ld+json LodgingBusiness block', () => {
    const detail = parseHotelDetail(detailFixture);
    expect(detail.name).toBe(RESOLVED_HOTEL_NAME);
    expect(detail.url).toBe('https://www.firotravel.cz/detail-zajezdu/spojene-arabske-emiraty/sheraton-jumeirah-beach-resort-towers/6564a');
    expect(detail.locality).toBe('Dubaj');
  });

  it('falls back to <link rel="canonical"> then og:url when ld+json carries no url', () => {
    const canonicalOnly = '<html><head><link rel="canonical" href="https://www.firotravel.cz/detail-zajezdu/recko/x/9a"></head><body><h1>Hotel X</h1></body></html>';
    expect(parseHotelDetail(canonicalOnly)).toEqual({
      name: 'Hotel X',
      url: 'https://www.firotravel.cz/detail-zajezdu/recko/x/9a',
      locality: null,
    });

    const ogOnly = '<html><head><meta property="og:url" content="https://www.firotravel.cz/detail-zajezdu/recko/y/10a" /></head><body><h1>Hotel Y</h1></body></html>';
    expect(parseHotelDetail(ogOnly).url).toBe('https://www.firotravel.cz/detail-zajezdu/recko/y/10a');
  });

  it('returns all-null for empty/unparseable HTML rather than throwing', () => {
    expect(parseHotelDetail('')).toEqual({ name: null, url: null, locality: null });
    expect(parseHotelDetail('<html><body>nothing useful</body></html>')).toEqual({ name: null, url: null, locality: null });
  });

  it('parseHotelNameFromDetail stays the name-only view of the same parse', () => {
    expect(parseHotelNameFromDetail(detailFixture)).toBe(parseHotelDetail(detailFixture).name);
  });
});

describe('detail-page enrichment upgrades URL and locality', () => {
  it('replaces the /detail-zajezdu/x/<id>a redirect with the canonical URL and fills in locality', async () => {
    const jsonMock = vi.fn().mockImplementation(async (_url?: string, init?: RequestInit) =>
      init === undefined ? countriesFixture : exotikaFixture,
    );
    const ctx: SourceContext = {
      http: {
        text: vi.fn().mockImplementation(async (url?: string) => {
          if (url === 'https://www.firotravel.cz/sitemap.xml') return sitemapIndexXml;
          if (url && /accommodations\.xml$/.test(url)) return accommodationsXml;
          if (url === 'https://www.firotravel.cz/detail-zajezdu/x/6564a') return detailFixture;
          return '<html><body>no name</body></html>';
        }),
        json: jsonMock,
      } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await firo.fetchOffers(ctx);
    const resolved = offers.filter((o) => o.title === RESOLVED_HOTEL_NAME);
    expect(resolved.length).toBeGreaterThan(0);
    for (const offer of resolved) {
      expect(offer.url).toBe('https://www.firotravel.cz/detail-zajezdu/spojene-arabske-emiraty/sheraton-jumeirah-beach-resort-towers/6564a');
      expect(offer.locality).toBe('Dubaj');
    }
  });
});
