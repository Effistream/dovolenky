import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDatourPackages, buildQueries, datour } from '../src/sources/datour.js';
import { offerKeyHash } from '../src/core/normalize.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures/datour', name), 'utf-8'));
}

// Live fixtures (curl, Chrome UA + `Referer: https://datour.cz/`; datour.cz name-blocks claudebot so
// only the Chrome UA is used — spec §16.4). The ONLY integration surface is
// GET https://search.anchoice.cz/web-search (the client bundle's Elastic credentials are never
// touched).
//  - web-search-maledivy.json / web-search-zanzibar.json (2026-07-07): ?page=1&location=…&package=0
//    → 18 packages each, total 184 / 90. Every row has package_price 0.0, original_price 0.0,
//    package_discount 0.0 → the priceTotal / claimed* fields are null. Carry the departure-city mix
//    (Praha/Vídeň/Frankfurt, Praha/Vídeň/Bratislava) that departureAirport now maps.
//  - web-search-thajsko.json (2026-07-29): ?…&location=29828&page_size=50&adults_count=2 → total
//    508, 50 rows. Proves page_size works, carries the '3.5'/'4.5' half-star categories that used to
//    be rounded UP, and is the truncation case (50 returned of 508 available).
//  - web-search-kapverdy.json (2026-07-29): ?…&location=452557&page_size=50 → total 37, all 37 rows
//    returned (no truncation). country_name is "Kapverdské ostrovy" — the spelling COUNTRY_BY_KEY
//    does not know — and 19 of its rows are the only live rows anywhere that populate
//    original_price, so this fixture pins both the country alias and the claimed-price branch.
const maledivyFixture = loadFixture('web-search-maledivy.json');
const zanzibarFixture = loadFixture('web-search-zanzibar.json');
const thajskoFixture = loadFixture('web-search-thajsko.json');
const kapverdyFixture = loadFixture('web-search-kapverdy.json');

const FALLBACK = 'https://datour.cz/vyhledavani?location=30182';

describe('parseDatourPackages — Maledivy fixture', () => {
  const offers = parseDatourPackages(maledivyFixture, FALLBACK);

  it('parses all 18 packages (no silent drops)', () => {
    expect(offers.length).toBe(18);
  });

  it('maps the first package (Pension Liberty Guest House) with hardcoded live values', () => {
    const first = offers[0]!;
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
    // Stable per-term+board key (room-agnostic, matching alexandria): live row has
    // tour_id "47943147", start 2027-05-16, nights 5, board_id "4".
    expect(first.sourceOfferKey).toBe(offerKeyHash(['47943147', '2027-05-16', 5, '4']));
    // Route is /zajezd/<detail>: bare /<detail> is the Next.js catch-all 404 (notFound:true).
    expect(first.url).toBe(
      'https://datour.cz/zajezd/maledivy/ari-atoll/-ari-atol-jih-/liberty-guesthouse-maldives' +
        '?item_id=Y2Vkb2tfcmVzYWJlZV9WSVRDX1M5OV9IQlg0MzA1NThfMjAyNy0wNS0xNl8yMDI3LTA1LTIyXzIwMjctMDUtMTdfMjAyNy0wNS0yMl81X0RCTC5EWF9GTElHSFRfVklFX1ZJRV9mX0FETF8xOC05OToz',
    );
  });

  it('maps departure_location_name to departureAirport (24% of live rows are non-CZ)', () => {
    // Live payload for this page: Praha 16, Vídeň 1, Frankfurt 1 — it used to be hardcoded null,
    // which made a Vienna/Frankfurt departure look CZ-equivalent on the board.
    const airports = offers.map((o) => o.departureAirport);
    expect(airports.filter((a) => a === 'Praha').length).toBe(16);
    expect(airports).toContain('Vídeň');
    expect(airports).toContain('Frankfurt');
    expect(airports.filter((a) => a === null).length).toBe(0);
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
      // This endpoint never populates package_price / original_price / package_discount here.
      expect(o.priceTotal).toBeNull();
      expect(o.claimedOriginalPrice).toBeNull();
      expect(o.claimedDiscountPct).toBeNull();
      expect(o.country).toBe('Maledivy');
      expect(o.transport).toBe('flight');
      expect(o.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.stars === null || (o.stars > 0 && Number.isInteger(o.stars))).toBe(true);
      expect(o.url.startsWith('https://datour.cz/zajezd/')).toBe(true);
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

  it('carries the Bratislava/Vídeň departure split', () => {
    const airports = offers.map((o) => o.departureAirport);
    expect(airports.filter((a) => a === 'Bratislava').length).toBe(2);
    expect(airports.filter((a) => a === 'Vídeň').length).toBe(8);
  });
});

describe('parseDatourPackages — Thajsko page_size=50 fixture (half-star truncation)', () => {
  const offers = parseDatourPackages(thajskoFixture, FALLBACK);

  it('parses a 50-row page — page_size buys coverage without extra requests', () => {
    // The old adapter hardcoded page=1 with the site's 18/page default; page_size=50 is the same
    // one request for 2.8x the rows.
    expect(offers.length).toBe(50);
    expect((thajskoFixture as { total: number }).total).toBe(508);
  });

  it('TRUNCATES half-star categories instead of rounding up (platform does the same)', () => {
    // accommodation_category '3.5' → the offer's own detail page reports hotel_category 3, and
    // '5.5' → 5. Math.round used to inflate ~8% of rows by a whole star.
    const half = offers.find((o) => o.title === 'Khao Lak Palm Beach')!; // '3.5'
    expect(half).toBeDefined();
    expect(half.stars).toBe(3);
    const half45 = offers.find((o) => o.title === 'Hotel Khao Lak Merlin Resort')!; // '4.5'
    expect(half45).toBeDefined();
    expect(half45.stars).toBe(4);
  });

  it('reaches deeper into the price-ascending tail than an 18-row page could', () => {
    const prices = offers.map((o) => o.pricePerPerson).sort((a, b) => a - b);
    expect(prices[0]).toBe(15839);
    // Page 1 of 18 rows stopped at 19 690 CZK; 50 rows carry the ladder past it.
    expect(prices[prices.length - 1]!).toBeGreaterThan(19690);
  });
});

describe('parseDatourPackages — Kapverdy fixture (country alias + claimed price)', () => {
  const offers = parseDatourPackages(kapverdyFixture, FALLBACK);

  it('resolves the anchoice spelling "Kapverdské ostrovy" to canonical Kapverdy', () => {
    // Without the alias, isKnownCountry rejects it → country null → every row dropped by the
    // country-scoped watch profiles. All 37 live rows use this spelling.
    expect(offers.length).toBe(37);
    expect(offers.every((o) => o.country === 'Kapverdy')).toBe(true);
  });

  it('maps the first package (Hotel Da Luz) against its live detail page', () => {
    const first = offers[0]!;
    expect(first.title).toBe('Hotel Da Luz');
    expect(first.pricePerPerson).toBe(16990); // == pageProps.data.person_price on /zajezd/…?item_id=
    expect(first.stars).toBe(3); // '3.0'; detail page hotel_category 3
    expect(first.board).toBe('BB'); // "Snídaně"
    expect(first.transport).toBe('flight'); // "Letecky"
    expect(first.departureAirport).toBe('Praha');
    expect(first.departureDate).toBe('2026-08-20');
    expect(first.nights).toBe(7);
    expect(first.locality).toBe('Santa Maria');
    expect(first.tourOperator).toBe('Blue Style');
    expect(first.url.startsWith('https://datour.cz/zajezd/kapverdske-ostrovy/ostrov-sal/santa-maria/hotel-da-luz?item_id=')).toBe(true);
  });

  it('populates claimedOriginalPrice from original_price (per-person) where the source has one', () => {
    // The only live rows anywhere that carry original_price. package_discount stays 0.0, so
    // claimedDiscountPct — the field that drives discount.ts's `fake` flag — remains null.
    const withOriginal = offers.filter((o) => o.claimedOriginalPrice !== null);
    expect(withOriginal.length).toBe(19);
    expect(offers[0]!.claimedOriginalPrice).toBe(39664);
    for (const o of withOriginal) {
      expect(o.claimedOriginalPrice!).toBeGreaterThan(o.pricePerPerson);
      expect(o.claimedDiscountPct).toBeNull();
    }
  });

  it('nulls stars for the accommodation_category "0.0" row', () => {
    expect(offers.filter((o) => o.stars === null).length).toBe(2); // one null category, one '0.0'
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

  it('dedupes (tour_id, start, nights, board_id) keeping the cheapest unit_price (order not guaranteed)', () => {
    // Two room variants of the same term+board, cheapest listed LAST (price-asc is not guaranteed).
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'room-suite', tour_id: '999', tour_name: 'Hotel Reef', start: '2026-08-01', nights: 7, board_id: '5', unit_price: 40000, country_name: 'Zanzibar' },
          { item_id: 'room-standard', tour_id: '999', tour_name: 'Hotel Reef', start: '2026-08-01', nights: 7, board_id: '5', unit_price: 28000, country_name: 'Zanzibar' },
        ],
      },
      FALLBACK,
    );
    expect(offers.length).toBe(1);
    expect(offers[0]!.pricePerPerson).toBe(28000);
    // The surviving offer carries the room-agnostic per-term+board key, NOT an item_id hash.
    expect(offers[0]!.sourceOfferKey).toBe(offerKeyHash(['999', '2026-08-01', 7, '5']));
  });

  it('keeps the sourceOfferKey STABLE when a cheaper room variant wins the bucket (week-to-week)', () => {
    // Week 1: only the suite variant is on sale. Week 2: a cheaper standard room (different
    // item_id, same tour_id/start/nights/board_id) appears and wins the bucket. The key must not
    // rotate — otherwise the watcher resets price history and misses the price-drop alert.
    const term = { tour_id: '999', tour_name: 'Hotel Reef', start: '2026-08-01', nights: 7, board_id: '5', country_name: 'Zanzibar' };
    const week1 = parseDatourPackages(
      { packages: [{ ...term, item_id: 'room-suite-w1', unit_price: 40000 }] },
      FALLBACK,
    );
    const week2 = parseDatourPackages(
      {
        packages: [
          { ...term, item_id: 'room-suite-w2', unit_price: 40000 },
          { ...term, item_id: 'room-standard-w2', unit_price: 28000 },
        ],
      },
      FALLBACK,
    );
    expect(week1.length).toBe(1);
    expect(week2.length).toBe(1);
    expect(week2[0]!.sourceOfferKey).toBe(week1[0]!.sourceOfferKey);
    expect(week2[0]!.pricePerPerson).toBe(28000); // ...while the price still drops to the cheapest.
  });

  it('keeps different boards of the same term as distinct offers with distinct keys', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'bb-room', tour_id: '999', tour_name: 'H', start: '2026-08-01', nights: 7, board_id: '4', board_name: 'Snídaně', unit_price: 30000, country_name: 'Zanzibar' },
          { item_id: 'ai-room', tour_id: '999', tour_name: 'H', start: '2026-08-01', nights: 7, board_id: '12', board_name: 'All Inclusive', unit_price: 38000, country_name: 'Zanzibar' },
        ],
      },
      FALLBACK,
    );
    expect(offers.length).toBe(2);
    expect(offers[0]!.sourceOfferKey).toBe(offerKeyHash(['999', '2026-08-01', 7, '4']));
    expect(offers[1]!.sourceOfferKey).toBe(offerKeyHash(['999', '2026-08-01', 7, '12']));
  });

  it('falls back to offerKeyHash([item_id]) ONLY when tour_id is missing (no merging)', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'orphan-1', tour_name: 'No tour id', start: '2026-08-01', nights: 7, board_id: '4', unit_price: 30000, country_name: 'Zanzibar' },
          { item_id: 'orphan-2', tour_name: 'No tour id', start: '2026-08-01', nights: 7, board_id: '4', unit_price: 28000, country_name: 'Zanzibar' },
        ],
      },
      FALLBACK,
    );
    // Without tour_id there is no safe term identity: rows stay distinct under their item_id keys.
    expect(offers.length).toBe(2);
    expect(offers[0]!.sourceOfferKey).toBe(offerKeyHash(['orphan-1']));
    expect(offers[1]!.sourceOfferKey).toBe(offerKeyHash(['orphan-2']));
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

  it('emits the bare /zajezd/ URL when item_id_encrypted is missing, and percent-encodes it when present', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'p1', tour_id: '1', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, detail: 'kuba/varadero/hotel' },
          { item_id: 'p2', tour_id: '2', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, detail: 'kuba/varadero/hotel', item_id_encrypted: 'a+b/c=' },
        ],
      },
      FALLBACK,
    );
    expect(offers[0]!.url).toBe('https://datour.cz/zajezd/kuba/varadero/hotel');
    // base64 payloads contain +, / and = — they must not leak into the query unescaped.
    expect(offers[1]!.url).toBe('https://datour.cz/zajezd/kuba/varadero/hotel?item_id=a%2Bb%2Fc%3D');
  });

  it('nulls the "Neuvedeno" departure placeholder instead of inventing a city', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'x1', tour_id: '1', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, departure_location_name: 'Neuvedeno' },
          { item_id: 'x2', tour_id: '2', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, departure_location_name: '  Vídeň  ' },
          { item_id: 'x3', tour_id: '3', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000 },
        ],
      },
      FALLBACK,
    );
    expect(offers[0]!.departureAirport).toBeNull();
    expect(offers[1]!.departureAirport).toBe('Vídeň');
    expect(offers[2]!.departureAirport).toBeNull();
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
    expect(offers[0]!.stars).toBe(4); // floor(4.5) — the platform truncates, it does not round
  });

  it('nulls stars when accommodation_category floors to 0 (guard applies AFTER flooring)', () => {
    const offers = parseDatourPackages(
      {
        packages: [
          { item_id: 'r', tour_id: '1', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, accommodation_category: '0.4', country_name: 'Maledivy' },
          { item_id: 's', tour_id: '2', tour_name: 'H', start: '2026-08-01', nights: 7, unit_price: 20000, accommodation_category: '0.0', country_name: 'Maledivy' },
        ],
      },
      FALLBACK,
    );
    expect(offers[0]!.stars).toBeNull();
    expect(offers[1]!.stars).toBeNull();
  });

  it('returns [] for missing/empty packages', () => {
    expect(parseDatourPackages({}, FALLBACK)).toEqual([]);
    expect(parseDatourPackages({ packages: [] }, FALLBACK)).toEqual([]);
    expect(parseDatourPackages(null, FALLBACK)).toEqual([]);
  });
});

describe('buildQueries — request budget', () => {
  const API = 'https://search.anchoice.cz/web-search';
  const queries = buildQueries(2);

  it('stays inside the hard request cap (run.ts aborts the adapter at 240 s)', () => {
    // 14 planned requests; MAX_REQUESTS is 20. If this ever fails, the query plan grew — re-measure
    // the wall clock before raising the cap.
    expect(queries.length).toBe(14);
    expect(queries.length).toBeLessThanOrEqual(20);
  });

  it('asks for page_size (not page=2,3,4…) — same rows for a third of the requests', () => {
    const solo = queries.filter((q) => !q.url.includes('%7C'));
    expect(solo.length).toBe(12);
    for (const q of solo) {
      expect(q.url).toContain('page=1&');
      expect(q.url).toContain('&page_size=50');
    }
    // Nothing in the plan pages beyond the first page.
    expect(queries.every((q) => q.url.includes('page=1&'))).toBe(true);
  });

  it('batches the 12 small-inventory countries into 2 multi-location requests', () => {
    const batched = queries.filter((q) => q.url.includes('%7C'));
    expect(batched.length).toBe(2);
    // `|` is the endpoint's OR separator and must go on the wire percent-encoded.
    expect(batched[0]!.url).toContain('location=27990%7C452557%7C28422%7C29724');
    expect(batched[0]!.url).toContain('&page_size=150');
    // Kuba (14 offers) moved from its own request into the second batch.
    expect(batched[1]!.url).toContain('28796');
  });

  it('covers all 24 exotika countries exactly once, with no duplicate location ids', () => {
    const ids = queries.flatMap((q) => decodeURIComponent(new URL(q.url).searchParams.get('location')!).split('|'));
    expect(ids.length).toBe(24);
    expect(new Set(ids).size).toBe(24);
    // The 12 ids the adapter shipped without — spec §16.1 already listed Keňa/Filipíny as verified.
    for (const id of ['29513', '27990', '452557', '28422', '29724', '567314', '599485', '30211', '29246', '28408', '452666', '27998']) {
      expect(ids).toContain(id);
    }
  });

  it('sends adults_count from ctx.adults and falls back to 2 for a nonsense value', () => {
    expect(buildQueries(3).every((q) => q.url.includes('&adults_count=3'))).toBe(true);
    expect(buildQueries(0).every((q) => q.url.includes('&adults_count=2'))).toBe(true);
    expect(buildQueries(Number.NaN).every((q) => q.url.includes('&adults_count=2'))).toBe(true);
  });

  it('builds absolute web-search URLs with the package=0 pricing plane', () => {
    for (const q of queries) {
      expect(q.url.startsWith(`${API}?`)).toBe(true);
      expect(q.url).toContain('&package=0');
      expect(q.fallbackUrl.startsWith('https://datour.cz/vyhledavani?location=')).toBe(true);
    }
  });
});

describe('datour source adapter', () => {
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

  it('is named datour and issues exactly the planned 14 queries', async () => {
    const { ctx, jsonMock } = makeCtx(standardImpl);
    const offers = await datour.fetchOffers(ctx);

    expect(datour.name).toBe('datour');
    expect(jsonMock).toHaveBeenCalledTimes(14);

    const urls = jsonMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual(buildQueries(2).map((q) => q.url));
    // 18 Maledivy + 18 Zanzibar = 36 (distinct (tour_id,start,nights,board_id) tuples across
    // countries — verified on the fixtures).
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

  it('logs a truncation line when the page did not hold the country', async () => {
    // The tripwire that the old page=1 behaviour lacked: Maledivy's fixture reports total 184 for
    // 18 returned rows, so a country outgrowing its page is visible in the scan log.
    const { ctx } = makeCtx(standardImpl);
    await datour.fetchOffers(ctx);
    const logged = (ctx.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(logged).toContain('datour: Maledivy truncated at 18/184 rows (price-ascending slice)');
    // A batch whose total fits in one page must NOT log.
    expect(logged.some((l) => /truncated at 0\/0/.test(l))).toBe(false);
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
      if (n === 1) return Promise.resolve(maledivyFixture); // 18 offers
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

  it('rethrows when the FIRST query is blocked before any success (backoff must engage)', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    const { ctx } = makeCtx(() => Promise.reject(new SourceBlockedError(403, 'blocked')));
    await expect(datour.fetchOffers(ctx)).rejects.toThrow('blocked');
  });

  it('logs the final summary line', async () => {
    const { ctx } = makeCtx(standardImpl);
    const logMock = ctx.log as ReturnType<typeof vi.fn>;
    await datour.fetchOffers(ctx);
    const logged = logMock.mock.calls.map((c) => c[0] as string);
    expect(logged.some((l) => /^datour: fetched \d+ offers across \d+ queries$/.test(l))).toBe(true);
  });
});
