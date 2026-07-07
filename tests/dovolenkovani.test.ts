import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseCesysDates,
  parseAccommodationsSitemap,
  extractAccommodationSitemapUrls,
  parseHotelNameFromDetail,
  dovolenkovani,
} from '../src/sources/dovolenkovani.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures/dovolenkovani', name), 'utf-8');
}

// dates-list.json is the real live response to the léto-moře query (duration 7-22 days,
// today..+60d) captured 2026-07-07 — see the probe-results header comment in
// src/sources/dovolenkovani.ts. It is intentionally NOT pre-filtered to duration_night >= 6:
// the app applies that floor client-side in fetchOffers, and parseCesysDates itself stays a
// generic, floor-agnostic mapper — so this fixture still contains some <6-night rows, letting
// the tests below exercise both parseCesysDates (raw) and the fetchOffers floor (filtered).
const datesListFixture = JSON.parse(loadFixture('dates-list.json'));
const countriesFixture = JSON.parse(loadFixture('countries.json'));
const sitemapXml = loadFixture('accommodations-sample.xml');
const sitemapIndexXml = loadFixture('sitemap-index-sample.xml');
// detail-320645.html is a trimmed live fixture (head ld+json + <h1>) captured 2026-07-07 from
// GET https://dovolenkovani.cz/detail-zajezdu/x/320645a (redirects to the canonical
// creek-hotel-residences-el-gouna slug) — see the file's own header comment for provenance.
const detailFixture = loadFixture('detail-320645.html');
const REAL_DETAIL_HOTEL_NAME = 'Creek Hotel & Residences El Gouna';
// The 12 exotic CESYS country ids the exotika query filters on (spec §16.1 row 11 — identical to
// firo's list; the CESYS country mapping is global across storefronts).
const EXOTIKA_COUNTRY_IDS = ['220', '131', '138', '198', '46', '142', '192', '215', '219', '112', '239', '102'];

/** Builds the same detail-page lookup URL fetchOffers uses, for use in test text() mocks. */
function detailUrl(id: number): string {
  return `https://dovolenkovani.cz/detail-zajezdu/x/${id}a`;
}

/** Matches the numeric "Hotel <id>" fallback title, mirroring FALLBACK_TITLE_RE in the source. */
const FALLBACK_TITLE_RE_FOR_TEST = /^Hotel \d+$/;

describe('parseAccommodationsSitemap', () => {
  const map = parseAccommodationsSitemap(sitemapXml);

  it('parses all 3 sitemap entries', () => {
    expect(map.size).toBe(3);
  });

  it('maps code "6a" to hotel id 6 with a title-cased name from the slug', () => {
    const entry = map.get(6);
    expect(entry).toBeDefined();
    expect(entry?.name).toBe('Kalia Beach');
    expect(entry?.url).toBe('https://dovolenkovani.cz/detail-zajezdu/kalia-beach/6a');
  });

  it('maps code "7a" to hotel id 7 (Nana Royal Premium)', () => {
    const entry = map.get(7);
    expect(entry?.name).toBe('Nana Royal Premium');
  });

  it('maps a longer numeric code "321968a" to hotel id 321968 (Jaz Elite Asteria)', () => {
    const entry = map.get(321968);
    expect(entry?.name).toBe('Jaz Elite Asteria');
  });

  it('returns an empty map for malformed/empty XML', () => {
    expect(parseAccommodationsSitemap('<urlset></urlset>').size).toBe(0);
    expect(parseAccommodationsSitemap('not xml at all').size).toBe(0);
  });
});

describe('parseHotelNameFromDetail', () => {
  it('extracts the real hotel name from the ld+json LodgingBusiness block, entities decoded', () => {
    expect(parseHotelNameFromDetail(detailFixture)).toBe(REAL_DETAIL_HOTEL_NAME);
  });

  it('falls back to the <h1> text when there is no ld+json block, decoding entities', () => {
    const html = '<html><head></head><body><h1>Creek Hotel &amp; Residences El Gouna</h1></body></html>';
    expect(parseHotelNameFromDetail(html)).toBe(REAL_DETAIL_HOTEL_NAME);
  });

  it('prefers ld+json over <h1> when both are present and disagree', () => {
    const html = `
      <html><head>
      <script type="application/ld+json">{"@type":"LodgingBusiness","name":"From LD-JSON"}</script>
      </head><body><h1>From H1</h1></body></html>`;
    expect(parseHotelNameFromDetail(html)).toBe('From LD-JSON');
  });

  it('ignores a ld+json block whose @type does not contain "Lodging" and falls back to <h1>', () => {
    const html = `
      <html><head>
      <script type="application/ld+json">{"@type":"BreadcrumbList","name":"Not a hotel"}</script>
      </head><body><h1>Real Hotel Name</h1></body></html>`;
    expect(parseHotelNameFromDetail(html)).toBe('Real Hotel Name');
  });

  it('returns null when neither ld+json nor <h1> is present', () => {
    expect(parseHotelNameFromDetail('<html><head></head><body><p>nothing here</p></body></html>')).toBeNull();
  });

  it('returns null for empty/whitespace-only html or an empty name/h1', () => {
    expect(parseHotelNameFromDetail('')).toBeNull();
    expect(parseHotelNameFromDetail('   ')).toBeNull();
    expect(parseHotelNameFromDetail('<html><body><h1>   </h1></body></html>')).toBeNull();
  });

  it('handles malformed HTML without throwing', () => {
    expect(() => parseHotelNameFromDetail('<html><script type="application/ld+json">{not json</html>')).not.toThrow();
  });
});

describe('parseCesysDates (fixture, dates-list.json)', () => {
  const hotelMap = parseAccommodationsSitemap(sitemapXml);
  const offers = parseCesysDates(datesListFixture, { hotels: hotelMap, countries: countriesFixture });

  it('parses 28 of 30 fixture rows (2 exact-duplicate rows in the live response collapse via dedup, no other silent drops)', () => {
    // The live fixture genuinely contains 2 duplicate [master_id, date_from, duration_night,
    // boarding_id] pairs (master_id 309883 appears twice for 2026-08-20 and twice for
    // 2026-08-27) — real API behavior, not a parsing bug. 30 raw rows - 2 duplicates = 28.
    expect(offers.length).toBe(28);
  });

  it('query-A (léto-moře, duration 7-22d) diversity: >=4 distinct master_id across the raw fixture, and >=2 distinct master_id remain among duration_night >= 6 rows', () => {
    // Regression guard for the "one cheap hotel, 2-5 nights" finding: the improved léto-moře
    // query (duration.from=7 server-side pre-filter) must return a materially more diverse set
    // of hotels than the old broad query did (which collapsed to 19/30 rows = 1 hotel).
    const rows = datesListFixture.data.dates as Array<{ master_id: number; duration_night: number }>;
    const allMasterIds = new Set(rows.map((r) => r.master_id));
    expect(allMasterIds.size).toBeGreaterThanOrEqual(4);

    const longStayMasterIds = new Set(rows.filter((r) => r.duration_night >= 6).map((r) => r.master_id));
    expect(longStayMasterIds.size).toBeGreaterThanOrEqual(2);
  });

  it('the raw fixture is NOT pre-filtered to duration_night >= 6 (that floor is applied by fetchOffers, not parseCesysDates)', () => {
    const nights = offers.map((o) => o.nights);
    expect(nights.some((n) => n !== null && n < 6)).toBe(true);
    expect(nights.some((n) => n !== null && n >= 6)).toBe(true);
  });

  it('maps the first row with real values (master_id 67752, Egypt, unknown hotel name)', () => {
    const first = offers[0]!;
    expect(first.source).toBe('dovolenkovani');
    // 67752 is not in our (tiny, 3-hotel) sitemap fixture -> falls back to "Hotel <id>".
    expect(first.title).toBe('Hotel 67752');
    expect(first.country).toBe('Egypt');
    expect(first.departureDate).toBe('2026-07-15');
    expect(first.nights).toBe(5);
    expect(first.board).toBe('AI');
    expect(first.departureAirport).toBe('PRG');
    expect(first.transport).toBe('flight');
    expect(first.pricePerPerson).toBe(16990);
    expect(first.tourOperator).toBe('Blue-style');
    expect(first.claimedDiscountPct).toBeNull();
    expect(first.claimedOriginalPrice).toBeNull();
    expect(first.url).toBe('https://dovolenkovani.cz/vyhledavani-zajezdu/');
  });

  it('uses the sitemap-derived hotel name and URL when master_id is known', () => {
    const synthetic = {
      status: 'success',
      data: {
        results: 1,
        more_exists: false,
        dates: [
          {
            master_id: 6,
            name: 6,
            date_from: '2026-08-01',
            date_to: '2026-08-08',
            duration_night: 7,
            boarding: 'All inclusive',
            boarding_id: 5,
            transport: 'Letecká',
            transport_id: 1,
            airport: 'Praha',
            airport_code: 'PRG',
            price_from: { CZK: 25000, EUR: 1030 },
            discount: null,
            discount_percent: null,
            country: 183,
            destination: 999,
            rating: 4,
            tour_operator: { name: 'Čedok' },
            last_minute: false,
            package_id: 1,
            composition: { adults: 2, children: [] },
          },
        ],
      },
    };
    const [offer] = parseCesysDates(synthetic, { hotels: hotelMap, countries: countriesFixture });
    expect(offer?.title).toBe('Kalia Beach');
    expect(offer?.url).toBe('https://dovolenkovani.cz/detail-zajezdu/kalia-beach/6a');
    expect(offer?.country).toBe('Řecko');
  });

  it('guards discount_percent to (0,100): null/0/100/out-of-range collapse to null claimedDiscountPct', () => {
    function withDiscount(pct: number | null) {
      const synthetic = {
        status: 'success',
        data: {
          results: 1,
          more_exists: false,
          dates: [
            {
              master_id: 999,
              name: 999,
              date_from: '2026-08-01',
              date_to: '2026-08-08',
              duration_night: 7,
              boarding: 'All inclusive',
              boarding_id: 5,
              transport: 'Letecká',
              transport_id: 1,
              airport: 'Praha',
              airport_code: 'PRG',
              price_from: { CZK: 20000, EUR: 800 },
              discount: pct !== null ? 5000 : null,
              discount_percent: pct,
              country: 183,
              destination: 999,
              rating: 4,
              tour_operator: { name: 'Čedok' },
              last_minute: false,
              package_id: 1,
              composition: { adults: 2, children: [] },
            },
          ],
        },
      };
      return parseCesysDates(synthetic, { hotels: hotelMap, countries: countriesFixture })[0]!;
    }

    expect(withDiscount(null).claimedDiscountPct).toBeNull();
    expect(withDiscount(0).claimedDiscountPct).toBeNull();
    expect(withDiscount(100).claimedDiscountPct).toBeNull();
    expect(withDiscount(150).claimedDiscountPct).toBeNull();

    const valid = withDiscount(25);
    expect(valid.claimedDiscountPct).toBe(25);
    expect(valid.claimedOriginalPrice).not.toBeNull();
    expect(valid.claimedOriginalPrice).toBeGreaterThan(valid.pricePerPerson);
  });

  it('maps transport_id 1 to flight even if the transport label text is unusual, and falls back to normalizeTransport otherwise', () => {
    const synthetic = {
      status: 'success',
      data: {
        results: 1,
        more_exists: false,
        dates: [
          {
            master_id: 42,
            name: 42,
            date_from: '2026-08-01',
            date_to: '2026-08-08',
            duration_night: 7,
            boarding: 'All inclusive',
            boarding_id: 5,
            transport: 'Vlastní doprava',
            transport_id: 2,
            airport: null,
            airport_code: null,
            price_from: { CZK: 15000, EUR: 600 },
            discount: null,
            discount_percent: null,
            country: 183,
            destination: 999,
            rating: 4,
            tour_operator: { name: 'Čedok' },
            last_minute: false,
            package_id: 1,
            composition: { adults: 2, children: [] },
          },
        ],
      },
    };
    const [offer] = parseCesysDates(synthetic, { hotels: hotelMap, countries: countriesFixture });
    expect(offer?.transport).toBe('own');
    expect(offer?.departureAirport).toBeNull();
  });

  it('resolves country via mapping + isKnownCountry guard, never a raw numeric id', () => {
    // country is null whenever the mapped name isn't in our known-country list (e.g. country id
    // 42 -> "Čína" in this live fixture, which isKnownCountry correctly rejects) — that's the
    // guard working as intended, not a bug, so we only assert the numeric-id-leak invariant on
    // the non-null offers.
    for (const offer of offers) {
      expect(offer.country === null || typeof offer.country === 'string').toBe(true);
      if (offer.country !== null) {
        expect(offer.country).not.toMatch(/^\d+$/);
      }
    }
    expect(offers.some((o) => o.country === null)).toBe(true);
  });

  it('enforces invariants: positive price, source tag, unique-ish sourceOfferKey, ISO date', () => {
    for (const offer of offers) {
      expect(offer.pricePerPerson).toBeGreaterThan(0);
      expect(offer.source).toBe('dovolenkovani');
      expect(offer.sourceOfferKey.length).toBeGreaterThan(0);
      expect(offer.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(offer.nights).toBeGreaterThan(0);
    }
  });

  it('dedupes rows with identical [master_id, date_from, duration_night, boarding_id]', () => {
    const doubled = {
      ...datesListFixture,
      data: { ...datesListFixture.data, dates: [...datesListFixture.data.dates, datesListFixture.data.dates[0]] },
    };
    const withDup = parseCesysDates(doubled, { hotels: hotelMap, countries: countriesFixture });
    expect(withDup.length).toBe(offers.length);
  });

  it('returns [] for a response with no dates array', () => {
    expect(parseCesysDates({ data: {} }, { hotels: hotelMap, countries: countriesFixture })).toEqual([]);
    expect(parseCesysDates({}, { hotels: hotelMap, countries: countriesFixture })).toEqual([]);
  });
});

describe('dovolenkovani source adapter', () => {
  function makeCtx(
    textImpl: (url?: string) => Promise<string>,
    jsonImpl: () => Promise<unknown>,
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

  it('is named dovolenkovani and issues 3 sitemap requests plus one detail-page lookup per distinct unresolved hotel', async () => {
    const sitemapUrls = new Set([
      'https://dovolenkovani.cz/sitemap.xml',
      'https://dovolenkovani.cz/accommodations.xml',
      'https://dovolenkovani.cz/am-accommodations.xml',
    ]);
    const { ctx, textMock, jsonMock } = makeCtx(
      async (url?: string) => {
        if (url === 'https://dovolenkovani.cz/sitemap.xml') return sitemapIndexXml;
        if (url && sitemapUrls.has(url)) return sitemapXml;
        // Anything else is a hotel-name detail-page lookup (dates-list.json's 4 distinct
        // master_ids are all unresolved by the tiny 3-hotel sitemap fixture) — return HTML with
        // no parseable name so those hotels simply keep their "Hotel <id>" fallback.
        return '<html><body>no name here</body></html>';
      },
      async () => datesListFixture,
    );

    const offers = await dovolenkovani.fetchOffers(ctx);

    expect(dovolenkovani.name).toBe('dovolenkovani');
    // Real sitemap index -> 2 matching accommodation URLs -> 1 (index) + 2 (shards) = 3 text()
    // calls, PLUS one detail-page lookup per distinct unresolved master_id in the fixture (4).
    expect(textMock.mock.calls.length).toBe(3 + 4);
    // json calls = 1 mapping/countries GET + one dates-list POST per query. Now 3 queries
    // (léto-moře, last-minute, exotika — spec §16.2) → up to 4 json calls.
    expect(jsonMock.mock.calls.length).toBeLessThanOrEqual(4);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.source === 'dovolenkovani')).toBe(true);
  });

  it('consults the sitemap index and fetches only the <loc> entries matching /accommodations/i (skips pages.xml)', () => {
    const urls = extractAccommodationSitemapUrls(sitemapIndexXml);
    expect(urls).toEqual([
      'https://dovolenkovani.cz/accommodations.xml',
      'https://dovolenkovani.cz/am-accommodations.xml',
    ]);
  });

  it('extractAccommodationSitemapUrls returns [] for malformed/empty/non-index XML', () => {
    expect(extractAccommodationSitemapUrls('<sitemapindex></sitemapindex>')).toEqual([]);
    expect(extractAccommodationSitemapUrls('not xml at all')).toEqual([]);
    expect(extractAccommodationSitemapUrls(sitemapXml)).toEqual([]); // a <urlset>, not a <sitemapindex>
  });

  it('falls back to fetching accommodations.xml directly when the sitemap index fetch fails', async () => {
    let textCallCount = 0;
    const { ctx, textMock } = makeCtx(
      async () => {
        textCallCount += 1;
        if (textCallCount === 1) throw new Error('sitemap.xml index 500');
        return sitemapXml; // fallback direct accommodations.xml fetch
      },
      async () => datesListFixture,
    );

    const offers = await dovolenkovani.fetchOffers(ctx);
    // Call 1 = failed index fetch, call 2 = fallback accommodations.xml fetch, calls 3-6 = one
    // detail-page hotel-name lookup per distinct unresolved master_id in the fixture (4).
    expect(textMock.mock.calls.length).toBe(2 + 4);
    expect(offers.length).toBeGreaterThan(0);
  });

  it('merges hotel maps from multiple accommodation sitemap shards found via the index', async () => {
    const amXmlWithHotel = `<?xml version="1.0" encoding="utf-8" ?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://dovolenkovani.cz/detail-zajezdu/extra-resort/999a</loc></url></urlset>`;
    let textCallCount = 0;
    const synthetic = {
      status: 'success',
      data: {
        results: 1,
        more_exists: false,
        dates: [
          {
            master_id: 999,
            name: 999,
            date_from: '2026-08-01',
            date_to: '2026-08-08',
            duration_night: 7,
            boarding: 'All inclusive',
            boarding_id: 5,
            transport: 'Letecká',
            transport_id: 1,
            airport: 'Praha',
            airport_code: 'PRG',
            price_from: { CZK: 20000, EUR: 800 },
            discount: null,
            discount_percent: null,
            country: 183,
            destination: 999,
            rating: 4,
            tour_operator: { name: 'Čedok' },
            last_minute: false,
            package_id: 1,
            composition: { adults: 2, children: [] },
          },
        ],
      },
    };
    const { ctx } = makeCtx(
      async () => {
        textCallCount += 1;
        if (textCallCount === 1) return sitemapIndexXml; // the index
        if (textCallCount === 2) return sitemapXml; // accommodations.xml (3 hotels)
        return amXmlWithHotel; // am-accommodations.xml (1 extra hotel, id 999)
      },
      async () => synthetic,
    );

    const offers = await dovolenkovani.fetchOffers(ctx);
    expect(offers.some((o) => o.title === 'Extra Resort')).toBe(true);
  });

  it('sends POST with JSON content-type for dates-list queries', async () => {
    const { ctx, jsonMock } = makeCtx(
      async () => sitemapXml,
      async () => datesListFixture,
    );

    await dovolenkovani.fetchOffers(ctx);

    // jsonMock is also used for the mapping/countries GET (no init/POST there) — only the
    // dates-list calls (identified by having a RequestInit as the 2nd arg) must be POST+JSON.
    const datesListCalls = jsonMock.mock.calls.filter((call) => call[1] !== undefined);
    expect(datesListCalls.length).toBeGreaterThan(0);
    for (const call of datesListCalls) {
      const init = call[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(typeof init.body).toBe('string');
    }
  });

  it('issues exactly one dates-list body carrying country_id (the exotika query), with the 12 exotic ids', async () => {
    const { ctx, jsonMock } = makeCtx(
      async () => sitemapXml,
      async () => datesListFixture,
    );
    await dovolenkovani.fetchOffers(ctx);

    const postBodies = jsonMock.mock.calls
      .filter((call) => call[1] !== undefined)
      .map((call) => JSON.parse((call[1] as RequestInit).body as string));
    // dovolenkovani now runs 3 queries: léto-moře, last-minute, exotika (spec §16.2).
    expect(postBodies.length).toBe(3);

    const withCountry = postBodies.filter((b) => b.country_id !== undefined);
    expect(withCountry.length).toBe(1);
    expect(withCountry[0].country_id).toEqual(EXOTIKA_COUNTRY_IDS);

    // The non-exotika queries must NOT carry a country_id at all (catalogue-wide, byte-identical
    // to the pre-exotika bodies).
    expect(postBodies.filter((b) => b.country_id === undefined).length).toBe(2);
  });

  it('degrades gracefully when the sitemap fetch fails (falls back to Hotel <id> / country still resolved)', async () => {
    const { ctx } = makeCtx(
      async () => {
        throw new Error('sitemap 500');
      },
      async () => datesListFixture,
    );

    const offers = await dovolenkovani.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers[0]?.title).toMatch(/^Hotel \d+$/);
  });

  it('degrades gracefully when the countries mapping fetch fails (country becomes null, not fatal)', async () => {
    let jsonCallCount = 0;
    const { ctx } = makeCtx(
      async () => sitemapXml,
      async () => {
        jsonCallCount += 1;
        if (jsonCallCount === 1) throw new Error('countries mapping 500');
        return datesListFixture;
      },
    );

    const offers = await dovolenkovani.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.country === null)).toBe(true);
  });

  it('rethrows when ALL dates-list queries fail (fischer pattern: total failure, not empty market)', async () => {
    const { ctx } = makeCtx(
      async () => sitemapXml,
      async () => {
        throw new Error('dates-list 500');
      },
    );

    await expect(dovolenkovani.fetchOffers(ctx)).rejects.toThrow();
  });

  it('stops on SourceBlockedError but keeps offers already collected from the other query', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    let jsonCallCount = 0;
    const { ctx, jsonMock } = makeCtx(
      async () => sitemapXml,
      async () => {
        jsonCallCount += 1;
        // Call 1 = mapping/countries (GET, succeeds). Call 2 = first dates-list query
        // (succeeds). Call 3 = second dates-list query (blocked).
        if (jsonCallCount <= 2) return datesListFixture;
        throw new SourceBlockedError(403, 'blocked');
      },
    );

    const offers = await dovolenkovani.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    expect(jsonMock.mock.calls.length).toBe(3);
    // These offers came ONLY from the léto-moře query (last-minute was blocked before it could
    // add any offers) — so this isolates and proves the client-side duration_night >= 6 floor,
    // even though the raw fixture (used for both queries here) contains shorter-stay rows too.
    const rawRowsUnder6Nights = (datesListFixture.data.dates as Array<{ duration_night: number }>).filter(
      (r) => r.duration_night < 6,
    ).length;
    expect(rawRowsUnder6Nights).toBeGreaterThan(0); // sanity: the fixture does contain short stays
    expect(offers.every((o) => o.nights !== null && o.nights >= 6)).toBe(true);
  });

  it('dedupes offers seen across both dates-list queries', async () => {
    const { ctx } = makeCtx(
      async () => sitemapXml,
      async () => datesListFixture,
    );

    const offers = await dovolenkovani.fetchOffers(ctx);
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe('hotel-name enrichment via detail-page redirect lookup', () => {
    // The live dates-list.json fixture has 4 distinct master_ids (67752, 309883, 341596, 104),
    // none of which are in the tiny 3-hotel sitemap fixture — so all 4 start on the numeric
    // "Hotel <id>" fallback and are candidates for detail-page lookup.
    const RESOLVABLE_ID = 67752;

    it('resolves the real hotel name via the detail-page redirect for a master_id not covered by the sitemap', async () => {
      const { ctx } = makeCtx(
        async (url?: string) => {
          if (url === detailUrl(RESOLVABLE_ID)) return detailFixture;
          if (url && /\/detail-zajezdu\/x\/\d+a$/.test(url)) return '<html><body>no name</body></html>';
          return sitemapXml;
        },
        async () => datesListFixture,
      );

      const offers = await dovolenkovani.fetchOffers(ctx);
      const resolved = offers.filter((o) => o.title === REAL_DETAIL_HOTEL_NAME);
      expect(resolved.length).toBeGreaterThan(0);
      // Every offer that used to be "Hotel 67752" is now resolved; no offer keeps the numeric
      // fallback for this specific id.
      expect(offers.some((o) => o.title === `Hotel ${RESOLVABLE_ID}`)).toBe(false);
    });

    it('a failed lookup for one hotel keeps its "Hotel <id>" fallback without crashing, while other hotels still resolve', async () => {
      const { ctx } = makeCtx(
        async (url?: string) => {
          if (url === detailUrl(RESOLVABLE_ID)) return detailFixture;
          if (url && /\/detail-zajezdu\/x\/\d+a$/.test(url)) throw new Error('detail page 500');
          return sitemapXml;
        },
        async () => datesListFixture,
      );

      const offers = await dovolenkovani.fetchOffers(ctx);
      expect(offers.some((o) => o.title === REAL_DETAIL_HOTEL_NAME)).toBe(true);
      // The other 3 distinct unresolved ids all failed their lookup -> keep the fallback.
      const stillFallback = offers.filter((o) => FALLBACK_TITLE_RE_FOR_TEST.test(o.title));
      expect(stillFallback.length).toBeGreaterThan(0);
    });

    it('stops issuing further lookups on SourceBlockedError but keeps names already resolved', async () => {
      const { SourceBlockedError } = await import('../src/core/http.js');
      const attemptedLookupUrls: string[] = [];
      const { ctx } = makeCtx(
        async (url?: string) => {
          if (url === detailUrl(RESOLVABLE_ID)) {
            attemptedLookupUrls.push(url);
            return detailFixture;
          }
          if (url && /\/detail-zajezdu\/x\/\d+a$/.test(url)) {
            attemptedLookupUrls.push(url);
            throw new SourceBlockedError(403, 'blocked');
          }
          return sitemapXml;
        },
        async () => datesListFixture,
      );

      const offers = await dovolenkovani.fetchOffers(ctx);
      // Once a SourceBlockedError is hit, no further lookups should be attempted — so at most
      // one lookup happens after the resolvable one if it happens to come first, but the loop
      // must stop as soon as the block is hit rather than trying all 4.
      expect(attemptedLookupUrls.length).toBeLessThan(4);
      expect(offers.length).toBeGreaterThan(0);
    });

    it('uses ctx.priorTitles to resolve a hotel without a detail-page lookup, and applies it to ALL of that master_id\'s offers', async () => {
      // master_id 67752 has one offer with sourceOfferKey a67121890c3b9e18 (date_from
      // 2026-07-15, duration_night 5, boarding_id 10) — see offerKeyHash([master_id, date_from,
      // duration_night, boarding_id]). A prior run resolved this hotel to a real name; this run
      // should reuse it for every one of 67752's 17 offers/terms without a detail lookup.
      const priorTitles = new Map<string, string>([['a67121890c3b9e18', 'Prior Resolved Hotel']]);
      let lookupCount67752 = 0;
      const { ctx } = makeCtx(
        async (url?: string) => {
          if (url === detailUrl(RESOLVABLE_ID)) {
            lookupCount67752 += 1;
            return detailFixture;
          }
          if (url && /\/detail-zajezdu\/x\/\d+a$/.test(url)) return '<html><body>no name</body></html>';
          return sitemapXml;
        },
        async () => datesListFixture,
      );
      ctx.priorTitles = priorTitles;

      const offers = await dovolenkovani.fetchOffers(ctx);

      // No detail-page lookup was spent on 67752 — it was resolved entirely from priorTitles.
      expect(lookupCount67752).toBe(0);
      const offers67752 = offers.filter((o) => o.sourceOfferKey === 'a67121890c3b9e18' || o.title === 'Prior Resolved Hotel');
      expect(offers67752.length).toBeGreaterThan(0);
      expect(offers.every((o) => (o.title === 'Prior Resolved Hotel') === isFrom67752(o))).toBe(true);

      function isFrom67752(o: { sourceOfferKey: string }): boolean {
        // All 17 offers for master_id 67752 in the fixture should now carry the prior title.
        return offers67752.some((x) => x.sourceOfferKey === o.sourceOfferKey);
      }
    });

    it('priorTitles reduces detail-page lookups spent, leaving cap headroom for genuinely-new hotels', async () => {
      // Without priorTitles, all 4 distinct unresolved master_ids (67752, 309883, 341596, 104)
      // would each cost one lookup. Feeding a prior title for 67752 should reduce that to 3.
      const priorTitles = new Map<string, string>([['a67121890c3b9e18', 'Prior Resolved Hotel']]);
      let lookupCount = 0;
      const { ctx } = makeCtx(
        async (url?: string) => {
          if (url && /\/detail-zajezdu\/x\/\d+a$/.test(url)) {
            lookupCount += 1;
            return '<html><body>no name</body></html>';
          }
          return sitemapXml;
        },
        async () => datesListFixture,
      );
      ctx.priorTitles = priorTitles;

      await dovolenkovani.fetchOffers(ctx);
      expect(lookupCount).toBe(3);
    });

    it('works fine when ctx.priorTitles is undefined (optional field, backward compatible)', async () => {
      const { ctx } = makeCtx(
        async (url?: string) => {
          if (url && /\/detail-zajezdu\/x\/\d+a$/.test(url)) return '<html><body>no name</body></html>';
          return sitemapXml;
        },
        async () => datesListFixture,
      );
      expect(ctx.priorTitles).toBeUndefined();

      const offers = await dovolenkovani.fetchOffers(ctx);
      expect(offers.length).toBeGreaterThan(0);
    });

    it('respects MAX_NAME_LOOKUPS: feeding many distinct unresolved ids caps lookups and logs a skip', async () => {
      const manyRows = Array.from({ length: 50 }, (_, i) => ({
        master_id: 500000 + i,
        name: 500000 + i,
        date_from: '2026-08-01',
        date_to: '2026-08-08',
        duration_night: 7,
        boarding: 'All inclusive',
        boarding_id: 5,
        transport: 'Letecká',
        transport_id: 1,
        airport: 'Praha',
        airport_code: 'PRG',
        price_from: { CZK: 20000, EUR: 800 },
        discount: null,
        discount_percent: null,
        country: 183,
        destination: 999,
        rating: 4,
        tour_operator: { name: 'Čedok' },
        last_minute: false,
        package_id: 1,
        composition: { adults: 2, children: [] },
      }));
      const manyIdsFixture = { status: 'success', data: { results: 50, more_exists: false, dates: manyRows } };

      let lookupCount = 0;
      const logs: string[] = [];
      const { ctx } = makeCtx(
        async (url?: string) => {
          if (url && /\/detail-zajezdu\/x\/\d+a$/.test(url)) {
            lookupCount += 1;
            return '<html><body>no name</body></html>';
          }
          return sitemapXml;
        },
        async () => manyIdsFixture,
      );
      ctx.log = (msg: string) => logs.push(msg);

      const offers = await dovolenkovani.fetchOffers(ctx);
      expect(offers.length).toBeGreaterThan(0);
      expect(lookupCount).toBeLessThanOrEqual(40);
      expect(logs.some((m) => /skip/i.test(m) && /40/.test(m))).toBe(true);
    });
  });
});
