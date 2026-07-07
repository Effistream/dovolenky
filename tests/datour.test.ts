import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDatourPackages, datour } from '../src/sources/datour.js';
import { offerKeyHash } from '../src/core/normalize.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures/datour', name), 'utf-8'));
}

// Live fixtures captured 2026-07-07 (curl, Chrome UA + `Referer: https://datour.cz/`; datour.cz
// name-blocks claudebot so only the Chrome UA is used — spec §16.4). The ONLY integration surface
// is GET https://search.anchoice.cz/web-search (spec §16.4 — the client bundle's Elastic
// credentials are never touched). See .superpowers/sdd/task-40-report.md for full evidence.
//  - web-search-maledivy.json: ?page=1&location=30182&package=0 → total 184, 18 packages, country
//    Maledivy, providers Čedok/Coral Travel/TUI/Flexi tours/Worldee, board mix
//    (Snídaně/Polopenze/Plná penze/Bez stravy). Every row has package_price 0.0, original_price
//    0.0, package_discount 0.0 (this endpoint does not populate the package/discount plane) → the
//    priceTotal / claimed* fields are null. Proves unit_price (per-person) is the sole live price.
//  - web-search-zanzibar.json: ?page=1&location=452587&package=0 → total 90, 18 packages, country
//    Zanzibar. Same 0.0 package/discount plane. Confirms the no-discount pattern across countries.
const maledivyFixture = loadFixture('web-search-maledivy.json');
const zanzibarFixture = loadFixture('web-search-zanzibar.json');

const FALLBACK = 'https://datour.cz/vyhledavani?location=30182';

describe('parseDatourPackages — Maledivy fixture', () => {
  const offers = parseDatourPackages(maledivyFixture, FALLBACK);

  it('parses all 18 packages (no silent drops)', () => {
    expect(offers.length).toBe(18);
  });

  it('maps the first package (Pension Liberty Guest House) with hardcoded live values', () => {
    const first = offers[0]!;
    const itemId =
      'cedok_resabee_VITC_S99_HBX430558_2027-05-16_2027-05-22_2027-05-17_2027-05-22_5_DBL.DX_FLIGHT_VIE_VIE_f_ADL_18-99:3';
    expect(first.source).toBe('datour');
    expect(first.title).toBe('Pension Liberty Guest House');
    expect(first.country).toBe('Maledivy');
    expect(first.locality).toBe('Ari Atol jih'); // destination_name " Ari Atol jih " trimmed
    expect(first.stars).toBe(3); // accommodation_category "3.0"
    expect(first.board).toBe('BB'); // "Snídaně"
    expect(first.transport).toBe('flight'); // "Letecky"
    expect(first.departureDate).toBe('2027-05-16');
    expect(first.nights).toBe(5);
    expect(first.pricePerPerson).toBe(23929); // unit_price 23929.0 (per person)
    expect(first.priceTotal).toBeNull(); // package_price 0.0 → null
    expect(first.claimedOriginalPrice).toBeNull(); // original_price 0.0
    expect(first.claimedDiscountPct).toBeNull(); // package_discount 0.0
    expect(first.omnibusLowestPrice).toBeNull();
    expect(first.tourOperator).toBe('Čedok'); // provider_name
    expect(first.departureAirport).toBeNull();
    expect(first.sourceOfferKey).toBe(offerKeyHash([itemId]));
    expect(first.url).toBe(
      'https://datour.cz/maledivy/ari-atoll/-ari-atol-jih-/liberty-guesthouse-maldives',
    );
  });

  it('leaves stars null when accommodation_category is null (package[1])', () => {
    // RASHU HIYAA, DHIFFUSHI — accommodation_category is null in the live payload.
    const row = offers.find((o) => o.title === 'RASHU HIYAA, DHIFFUSHI')!;
    expect(row).toBeDefined();
    expect(row.stars).toBeNull();
    expect(row.locality).toBe('Male Atol sever'); // destination_name "Male Atol sever " trimmed
  });

  it('enforces invariants across every Maledivy offer', () => {
    for (const o of offers) {
      expect(o.source).toBe('datour');
      expect(o.sourceOfferKey.length).toBeGreaterThan(0);
      expect(o.pricePerPerson).toBeGreaterThan(0);
      // This endpoint never populates package_price / original_price / package_discount.
      expect(o.priceTotal).toBeNull();
      expect(o.claimedOriginalPrice).toBeNull();
      expect(o.claimedDiscountPct).toBeNull();
      expect(o.country).toBe('Maledivy');
      expect(o.transport).toBe('flight');
      expect(o.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.stars === null || (o.stars > 0 && Number.isInteger(o.stars))).toBe(true);
      expect(o.url.startsWith('https://datour.cz/')).toBe(true);
    }
  });

  it('covers the live board variety (BB/HB/FB/none)', () => {
    const boards = new Set(offers.map((o) => o.board));
    // Maledivy fixture carries Snídaně/Polopenze/Plná penze/Bez stravy.
    expect(boards.has('BB')).toBe(true);
    expect(boards.has('none')).toBe(true);
  });
});

describe('parseDatourPackages — Zanzibar fixture', () => {
  const offers = parseDatourPackages(zanzibarFixture, FALLBACK);

  it('parses all 18 Zanzibar packages', () => {
    expect(offers.length).toBe(18);
    expect(offers.every((o) => o.source === 'datour')).toBe(true);
    expect(offers.every((o) => o.country === 'Zanzibar')).toBe(true);
  });

  it('leaves claimed discount + priceTotal fields null (no discount plane)', () => {
    for (const o of offers) {
      expect(o.claimedOriginalPrice).toBeNull();
      expect(o.claimedDiscountPct).toBeNull();
      expect(o.priceTotal).toBeNull();
    }
  });
});

describe('parseDatourPackages — mapping rules & edge cases', () => {
  it('skips rows with unit_price <= 0 or missing', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'A', tour_id: '1', tour_name: 'No price', start: '2026-07-08', nights: 7 },
          { item_id: 'B', tour_id: '2', tour_name: 'Zero', start: '2026-07-08', nights: 7, unit_price: 0 },
          { item_id: 'C', tour_id: '3', tour_name: 'Negative', start: '2026-07-08', nights: 7, unit_price: -5 },
          { item_id: 'D', tour_id: '4', tour_name: 'Good', start: '2026-07-08', nights: 7, unit_price: 30000, country_name: 'Maledivy', detail: 'x' },
        ],
      },
      FALLBACK,
    );
    expect(offers.length).toBe(1);
    expect(offers[0]!.title).toBe('Good');
    expect(offers[0]!.pricePerPerson).toBe(30000);
  });

  it('dedupes (tour_id, start, nights) keeping the cheapest unit_price (order not guaranteed)', () => {
    // Two room variants of the same term, cheapest listed LAST (price-asc is not guaranteed).
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'room-suite', tour_id: '999', tour_name: 'Hotel Reef', start: '2026-08-01', nights: 7, unit_price: 40000, country_name: 'Zanzibar' },
          { item_id: 'room-standard', tour_id: '999', tour_name: 'Hotel Reef', start: '2026-08-01', nights: 7, unit_price: 28000, country_name: 'Zanzibar' },
        ],
      },
      FALLBACK,
    );
    expect(offers.length).toBe(1);
    expect(offers[0]!.pricePerPerson).toBe(28000);
    // The surviving offer keeps the cheapest variant's own item_id key.
    expect(offers[0]!.sourceOfferKey).toBe(offerKeyHash(['room-standard']));
  });

  it('does NOT merge different terms of the same tour_id', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'a', tour_id: '999', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 30000, country_name: 'Zanzibar' },
          { item_id: 'b', tour_id: '999', tour_name: 'H', start: '2026-08-08', nights: 7, unit_price: 31000, country_name: 'Zanzibar' },
          { item_id: 'c', tour_id: '999', tour_name: 'H', start: '2026-08-01', nights: 10, unit_price: 42000, country_name: 'Zanzibar' },
        ],
      },
      FALLBACK,
    );
    expect(offers.length).toBe(3);
  });

  it('sets priceTotal from package_price only when > 0', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'z', tour_id: '1', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, package_price: 39000, country_name: 'Zanzibar' },
        ],
      },
      FALLBACK,
    );
    expect(offers[0]!.priceTotal).toBe(39000);
  });

  it('derives claimed fields: original_price (per-person) > unit_price, and package_discount as pct', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'd', tour_id: '1', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, original_price: 25000, package_discount: 20, country_name: 'Zanzibar' },
        ],
      },
      FALLBACK,
    );
    expect(offers[0]!.claimedOriginalPrice).toBe(25000);
    expect(offers[0]!.claimedDiscountPct).toBe(20);
  });

  it('nulls claimedOriginalPrice when original_price is 0 or <= unit_price', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'e', tour_id: '1', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, original_price: 20000, country_name: 'Zanzibar' },
          { item_id: 'f', tour_id: '2', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, original_price: 0, country_name: 'Zanzibar' },
        ],
      },
      FALLBACK,
    );
    expect(offers[0]!.claimedOriginalPrice).toBeNull();
    expect(offers[1]!.claimedOriginalPrice).toBeNull();
  });

  it('nulls claimedDiscountPct when package_discount is out of (0,100)', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'g', tour_id: '1', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, package_discount: 0, country_name: 'Zanzibar' },
          { item_id: 'h', tour_id: '2', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, package_discount: 100, country_name: 'Zanzibar' },
        ],
      },
      FALLBACK,
    );
    expect(offers[0]!.claimedDiscountPct).toBeNull();
    expect(offers[1]!.claimedDiscountPct).toBeNull();
  });

  it('gates country by isKnownCountry (unknown → null)', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'k', tour_id: '1', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, country_name: 'Neverland' },
        ],
      },
      FALLBACK,
    );
    expect(offers[0]!.country).toBeNull();
  });

  it('locality falls back to state_name then null', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'm', tour_id: '1', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, destination_name: '   ', state_name: 'Male Atol' },
          { item_id: 'n', tour_id: '2', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000 },
        ],
      },
      FALLBACK,
    );
    expect(offers[0]!.locality).toBe('Male Atol');
    expect(offers[1]!.locality).toBeNull();
  });

  it('uses the fallbackUrl argument when the detail slug is missing', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'p', tour_id: '1', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000 },
        ],
      },
      FALLBACK,
    );
    expect(offers[0]!.url).toBe(FALLBACK);
  });

  it('coerces string-typed numeric fields (API returns some prices as strings)', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'q', tour_id: '1', tour_name: 'H', start: '2026-08-01', nights: '7', unit_price: '23929.0', accommodation_category: '4.5', country_name: 'Maledivy' },
        ],
      },
      FALLBACK,
    );
    expect(offers[0]!.pricePerPerson).toBe(23929);
    expect(offers[0]!.nights).toBe(7);
    expect(offers[0]!.stars).toBe(5); // round(4.5)
  });

  it('returns [] for missing/empty packages', () => {
    expect(parseDatourPackages({}, FALLBACK)).toEqual([]);
    expect(parseDatourPackages({ packages: [] }, FALLBACK)).toEqual([]);
    expect(parseDatourPackages(null, FALLBACK)).toEqual([]);
  });
});

describe('datour source adapter', () => {
  const API = 'https://search.anchoice.cz/web-search';
  const LOCATION_IDS = ['30182', '29828', '452587', '451780', '28824', '30594', '28796', '29920', '28075', '450831', '29632', '29011'];

  function makeCtx(jsonImpl: (url?: string, init?: RequestInit) => Promise<unknown>): {
    ctx: SourceContext;
    jsonMock: ReturnType<typeof vi.fn>;
  } {
    const jsonMock = vi.fn().mockImplementation(jsonImpl);
    const ctx: SourceContext = {
      http: { json: jsonMock, text: vi.fn() } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };
    return { ctx, jsonMock };
  }

  // Maledivy + Zanzibar locations return their fixtures; every other location is empty.
  function standardImpl(url?: string): Promise<unknown> {
    if (url && url.includes('location=30182')) return Promise.resolve(maledivyFixture);
    if (url && url.includes('location=452587')) return Promise.resolve(zanzibarFixture);
    return Promise.resolve({ total: 0, packages: [] });
  }

  it('is named datour and issues one page-1 query per location (12) with package=0', async () => {
    const { ctx, jsonMock } = makeCtx(standardImpl);
    const offers = await datour.fetchOffers(ctx);

    expect(datour.name).toBe('datour');
    expect(jsonMock).toHaveBeenCalledTimes(12);

    const urls = jsonMock.mock.calls.map((c) => c[0] as string);
    for (const id of LOCATION_IDS) {
      expect(urls).toContain(`${API}?page=1&location=${id}&package=0`);
    }
    // 18 Maledivy + 18 Zanzibar = 36 (distinct item_ids across countries).
    expect(offers.length).toBe(36);
    expect(offers.every((o) => o.source === 'datour')).toBe(true);
    expect(offers.some((o) => o.country === 'Maledivy')).toBe(true);
    expect(offers.some((o) => o.country === 'Zanzibar')).toBe(true);
  });

  it('sends the Referer: https://datour.cz/ header on every request', async () => {
    const { ctx, jsonMock } = makeCtx(standardImpl);
    await datour.fetchOffers(ctx);
    for (const call of jsonMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.Referer).toBe('https://datour.cz/');
    }
  });

  it('dedupes offers across queries by sourceOfferKey', async () => {
    const { ctx } = makeCtx(standardImpl);
    const offers = await datour.fetchOffers(ctx);
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('isolates a per-query failure without sinking the whole fetch', async () => {
    let n = 0;
    const { ctx } = makeCtx((url?: string) => {
      n += 1;
      if (n === 1) return Promise.reject(new Error('network blip'));
      return standardImpl(url);
    });
    const offers = await datour.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
  });

  it('stops issuing further queries on SourceBlockedError but keeps offers already collected', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    let n = 0;
    const { ctx, jsonMock } = makeCtx((url?: string) => {
      n += 1;
      if (n === 1) return standardImpl(url); // Maledivy -> 18 offers
      if (n === 2) return Promise.reject(new SourceBlockedError(403, 'blocked'));
      return standardImpl(url);
    });
    const offers = await datour.fetchOffers(ctx);
    expect(offers.length).toBe(18);
    expect(jsonMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows when ALL queries fail so runScan marks the source failed', async () => {
    const { ctx } = makeCtx(() => Promise.reject(new Error('total outage')));
    await expect(datour.fetchOffers(ctx)).rejects.toThrow('total outage');
  });

  it('logs the final summary line', async () => {
    const { ctx } = makeCtx(standardImpl);
    const logMock = ctx.log as ReturnType<typeof vi.fn>;
    await datour.fetchOffers(ctx);
    const logged = logMock.mock.calls.map((c) => c[0] as string);
    expect(logged.some((l) => /^datour: fetched \d+ offers across \d+ queries$/.test(l))).toBe(true);
  });
});
