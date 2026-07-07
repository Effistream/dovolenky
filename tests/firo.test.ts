import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { firo } from '../src/sources/firo.js';
import {
  parseCesysDates,
  parseAccommodationsSitemap,
  parseHotelNameFromDetail,
  type CesysMaps,
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
const exotikaFixture = JSON.parse(loadFixture('dates-list-exotika.json'));
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
    // firo runs 3 queries: leto-more, last-minute, exotika.
    expect(postBodies.length).toBe(3);

    const withCountry = postBodies.filter((b) => b.country_id !== undefined);
    expect(withCountry.length).toBe(1);
    expect(withCountry[0].country_id).toEqual(EXOTIKA_COUNTRY_IDS);

    // The non-exotika queries must NOT carry a country_id at all (catalogue-wide).
    expect(postBodies.filter((b) => b.country_id === undefined).length).toBe(2);
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
    expect(datesListCalls.length).toBe(3);
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
