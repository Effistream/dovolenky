import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAlexandria, buildQueries, alexandria } from '../src/sources/alexandria.js';
import { offerKeyHash } from '../src/core/normalize.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures/alexandria', name), 'utf-8'));
}

// Live fixtures (curl, Chrome UA, alexandria.cz has no anti-bot / permissive robots — spec §16.1
// row 12). Each file is a complete, unedited web-search response.
//
// Captured 2026-07-07 (see .superpowers/sdd/task-36-report.md):
//  - web-search-page1.json: GET https://bck-new.alexandria.cz/web-search?page=1 (default feed):
//    18 packages, all currently discounted (original_price > package_price), Mediterranean
//    countries, board All Inclusive / Ultra All inclusive, transport Letecky. Proves the
//    per-person + discount math, and carries the one fractional accommodation_category (3.5).
//  - web-search-bali.json: GET ...?page=1&location=453246 (Bali, exotic season fallback since
//    Maledivy 3175 is seasonally empty in July): 10 packages, country Indonésie, board mix
//    (Bez stravy / Snídaně), tour_id as "BV_xxx" strings, board_id null, and — critically —
//    original_price == package_price on every row, proving the no-discount guard.
//  - web-search-maledivy.json: GET ...?page=1&location=3175 → {packages:[], total:0}: the
//    seasonal-empty exotic location (winter product not yet on sale), proving empty → [].
//
// Captured 2026-07-29 for the coverage rewrite (the slices the old 2-page window never reached):
//  - web-search-feed-tail.json: GET ...?page=6&page_size=200 — the last feed page, 19 rows, ALL of
//    them Worldee partner inventory whose `detail` is an ABSOLUTE alexandria.worldee.com URL, all
//    zero-discount, accommodation_category 0, cheap (3-5 nights), and mostly in countries outside
//    the project's canonical list. Proves the absolute-URL passthrough and country→null.
//  - web-search-italie-zima.json: GET ...?page=1&page_size=200&location=147 — 41 rows, every one
//    country_name 'Itálie (zima)' and transport 'Vlastní'. Proves the parenthetical-country strip
//    and self-drive transport, and holds a second fractional category (3.5, La Mirandola).
const page1Fixture = loadFixture('web-search-page1.json');
const baliFixture = loadFixture('web-search-bali.json');
const maledivyFixture = loadFixture('web-search-maledivy.json');
const tailFixture = loadFixture('web-search-feed-tail.json');
const zimaFixture = loadFixture('web-search-italie-zima.json');

describe('parseAlexandria — default feed (page 1)', () => {
  const offers = parseAlexandria(page1Fixture);

  it('parses all 18 packages (no silent drops)', () => {
    expect(offers.length).toBe(18);
  });

  it('maps the first package (Belvedere Alexandria Club) with hardcoded live values', () => {
    const first = offers[0]!;
    expect(first.source).toBe('alexandria');
    expect(first.title).toBe('Belvedere Alexandria Club');
    expect(first.country).toBe('Bulharsko');
    expect(first.locality).toBe('Primorsko');
    expect(first.stars).toBe(5);
    expect(first.board).toBe('AI');
    expect(first.transport).toBe('flight');
    expect(first.departureDate).toBe('2026-07-08');
    expect(first.nights).toBe(7);
    // package_price 35980 is the TOTAL for the party of persons=2 -> 17990/person.
    expect(first.pricePerPerson).toBe(17990);
    expect(first.priceTotal).toBe(35980);
    // original_price 74980 (total, crossed-out) > package_price -> per-person 37490, ~52% off.
    expect(first.claimedOriginalPrice).toBe(37490);
    expect(first.claimedDiscountPct).toBe(52);
    expect(first.omnibusLowestPrice).toBeNull();
    expect(first.sourceOfferKey).toBe(offerKeyHash(['4782', '2026-07-08', 7, 5]));
  });

  it('deep-links the exact departure term via ages + autofixes', () => {
    // Regression: a bare /hotel/<detail> opens the detail page's OWN default term — verified live
    // 2026-07-29 on BV_281 (feed row 2026-08-03, bare page rendered 2026-08-24 at +19% price).
    // `autofixes` is the term id the site's own result cards link with; `ages` is one 20-year-old
    // adult per `persons`, so the page prices the same party as the row.
    const first = offers[0]!;
    expect(first.url).toBe(
      'https://www.alexandria.cz/hotel/4782-belvedere-alexandria-club?ages=1_20%7C2_20&autofixes=2910896',
    );
  });

  it('floors a fractional accommodation_category (3.5 -> 3 stars, not 4)', () => {
    // tour 9109 "Aguamarina Alexandria Club" has accommodation_category 3.5 and the site's own
    // header draws 3 full stars + a half star. Math.round used to inflate it to a 4* hotel.
    const row = offers.find((o) => o.title === 'Aguamarina Alexandria Club')!;
    expect(row).toBeDefined();
    expect(row.stars).toBe(3);
    expect(row.country).toBe('Španělsko');
  });

  it('enforces invariants across every default-feed offer', () => {
    for (const o of offers) {
      expect(o.source).toBe('alexandria');
      expect(o.sourceOfferKey.length).toBeGreaterThan(0);
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(o.priceTotal).toBeGreaterThan(0);
      // priceTotal is the group price; pricePerPerson never exceeds it.
      expect(o.pricePerPerson).toBeLessThanOrEqual(o.priceTotal!);
      expect(o.country === null || typeof o.country === 'string').toBe(true);
      expect(o.transport).toBe('flight');
      expect(o.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.stars === null || (o.stars > 0 && Number.isInteger(o.stars))).toBe(true);
      // Every default-feed row is discounted -> claimed fields are consistent.
      expect(o.claimedOriginalPrice).toBeGreaterThan(o.pricePerPerson);
      expect(o.claimedDiscountPct).toBeGreaterThan(0);
    }
  });
});

describe('parseAlexandria — exotic Bali feed (no-discount + BB/none board)', () => {
  const offers = parseAlexandria(baliFixture);

  it('parses all 10 Indonésie packages', () => {
    expect(offers.length).toBe(10);
    expect(offers.every((o) => o.source === 'alexandria')).toBe(true);
    expect(offers.every((o) => o.country === 'Indonésie')).toBe(true);
  });

  it('leaves claimed discount fields null when original_price == package_price', () => {
    for (const o of offers) {
      expect(o.claimedOriginalPrice).toBeNull();
      expect(o.claimedDiscountPct).toBeNull();
    }
  });

  it('maps the first Bali package (string tour_id, null board_id) exactly', () => {
    const first = offers[0]!;
    expect(first.title).toBe('Adi Dharma Hotel Kuta');
    expect(first.board).toBe('none'); // "Bez stravy"
    expect(first.locality).toBe('Kuta');
    expect(first.stars).toBe(4);
    expect(first.pricePerPerson).toBe(31830); // 63660 / 2
    expect(first.priceTotal).toBe(63660);
    expect(first.url).toBe(
      'https://www.alexandria.cz/hotel/BV_281-adi-dharma-hotel-kuta' +
        '?ages=1_20%7C2_20&autofixes=BV_281_2026-07-13_2026-07-21_19689_3_1_8_10',
    );
    // board_id is null on Bali rows -> hashed as '' by offerKeyHash.
    expect(first.sourceOfferKey).toBe(offerKeyHash(['BV_281', '2026-07-13', 7, null]));
  });

  it('normalizes "Snídaně" board to BB', () => {
    const bb = offers.find((o) => o.board === 'BB');
    expect(bb).toBeDefined();
  });
});

describe('parseAlexandria — feed tail (Worldee partner rows)', () => {
  const offers = parseAlexandria(tailFixture);

  it('parses all 19 tail packages', () => {
    expect(offers.length).toBe(19);
  });

  it('passes an absolute `detail` URL through verbatim instead of prefixing /hotel/', () => {
    // Regression: 158 of 916 live feed rows carry an absolute alexandria.worldee.com URL in
    // `detail`; the old builder emitted https://www.alexandria.cz/hotel/https://alexandria...
    const first = offers[0]!;
    expect(first.title).toContain('Litva');
    expect(first.url).toBe(
      'https://alexandria.worldee.com/cz/trip/detail?tripId=790413&tourId=2202603',
    );
    for (const o of offers) {
      expect(o.url.startsWith('https://alexandria.worldee.com/')).toBe(true);
      expect(o.url).not.toContain('/hotel/https');
    }
  });

  it('reaches the cheap band the two-page window could never return', () => {
    // The old adapter's floor was 17,990 CZK/person; this page alone goes well below it.
    const min = Math.min(...offers.map((o) => o.pricePerPerson));
    expect(min).toBeLessThan(10000);
  });

  it('keeps country null for destinations outside the canonical list, canonical where known', () => {
    const litva = offers[0]!;
    expect(litva.country).toBeNull(); // 'Litva' is not in the project's country taxonomy
    expect(offers.some((o) => o.country === 'Kypr')).toBe(true);
    expect(offers.some((o) => o.country === 'Maďarsko')).toBe(true);
    // accommodation_category 0 on every Worldee row -> stars null, never 0.
    expect(offers.every((o) => o.stars === null)).toBe(true);
  });
});

describe('parseAlexandria — Itálie (zima): parenthetical country + self-drive', () => {
  const offers = parseAlexandria(zimaFixture);

  it('parses all 41 packages', () => {
    expect(offers.length).toBe(41);
  });

  it("strips the season qualifier so 'Itálie (zima)' resolves to Itálie (not null)", () => {
    // Regression: normalizeCountry/isKnownCountry tokenize on /[\/,–-]/ and never strip a
    // parenthesis, so these rows used to get country=null — which nulls computeMatchKey /
    // computeHotelKey and drops them out of cross-source matching entirely.
    expect(offers.every((o) => o.country === 'Itálie')).toBe(true);
  });

  it("maps 'Vlastní' transport to own on every row", () => {
    expect(offers.every((o) => o.transport === 'own')).toBe(true);
  });

  it('maps the first winter package exactly', () => {
    const first = offers[0]!;
    expect(first.title).toBe('Gardenia');
    expect(first.locality).toBe('Bormio');
    expect(first.stars).toBe(3);
    expect(first.board).toBe('HB'); // "Polopenze"
    expect(first.departureDate).toBe('2026-11-28');
    expect(first.nights).toBe(7);
    expect(first.priceTotal).toBe(23180);
    expect(first.pricePerPerson).toBe(11590);
    expect(first.claimedOriginalPrice).toBe(12790); // 25580 / 2
    expect(first.claimedDiscountPct).toBe(9);
    expect(first.url).toBe(
      'https://www.alexandria.cz/hotel/11524-gardenia?ages=1_20%7C2_20&autofixes=3048801',
    );
  });

  it('floors the second live fractional category too (La Mirandola 3.5 -> 3)', () => {
    const row = offers.find((o) => o.title === 'La Mirandola')!;
    expect(row).toBeDefined();
    expect(row.stars).toBe(3);
  });
});

describe('parseAlexandria — edge cases', () => {
  it('returns [] for a seasonally-empty exotic location (Maledivy)', () => {
    expect(parseAlexandria(maledivyFixture)).toEqual([]);
  });

  it('returns [] for a response with no packages array', () => {
    expect(parseAlexandria({})).toEqual([]);
    expect(parseAlexandria({ packages: [] })).toEqual([]);
    expect(parseAlexandria(null)).toEqual([]);
  });

  it('skips rows with missing/non-positive package_price or missing start', () => {
    const bad = {
      packages: [
        { tour_id: 'A', tour_name: 'No price', detail: 'a', start: '2026-07-08', nights: 7, persons: 2 },
        { tour_id: 'B', tour_name: 'Zero price', detail: 'b', start: '2026-07-08', nights: 7, persons: 2, package_price: 0 },
        { tour_id: 'C', tour_name: 'No start', detail: 'c', nights: 7, persons: 2, package_price: 30000 },
        { tour_id: 'D', tour_name: 'Good', detail: 'd-good', start: '2026-07-08', nights: 7, persons: 2, package_price: 30000, country_name: 'Bulharsko', board_name: 'Snídaně', transport_name: 'Letecky', accommodation_category: 4.0 },
      ],
    };
    const offers = parseAlexandria(bad);
    expect(offers.length).toBe(1);
    expect(offers[0]!.title).toBe('Good');
    expect(offers[0]!.pricePerPerson).toBe(15000);
  });

  it('falls back to persons=1 (treats package_price as per-person) when persons is missing/invalid', () => {
    const offers = parseAlexandria({
      packages: [
        { tour_id: 'E', tour_name: 'No persons', detail: 'e', autofixes: 'T1', start: '2026-07-08', nights: 7, package_price: 20000 },
      ],
    });
    expect(offers.length).toBe(1);
    expect(offers[0]!.pricePerPerson).toBe(20000);
    expect(offers[0]!.priceTotal).toBe(20000);
    // ages carries one entry per person, so the persons=1 fallback links a single-adult party.
    expect(offers[0]!.url).toBe('https://www.alexandria.cz/hotel/e?ages=1_20&autofixes=T1');
  });

  it('treats an absurd persons count as invalid instead of building a giant ages string', () => {
    // Regression (review 2026-07-29): `persons` is remote input and drove BOTH the price division
    // and an `ages` array built one entry per person. persons=5_000_000 produced a 63.9 MB url
    // string (measured) with pricePerPerson 0 — and nothing downstream caps url length or rejects a
    // 0 price, so both would have been written to the DB. Out-of-range -> the persons=1 fallback.
    const offers = parseAlexandria({
      packages: [
        { tour_id: 'BIG', tour_name: 'Absurd party', detail: 'big', autofixes: 'T', start: '2026-08-01', nights: 7, persons: 5_000_000, package_price: 30000 },
      ],
    });
    expect(offers.length).toBe(1);
    expect(offers[0]!.pricePerPerson).toBe(30000);
    expect(offers[0]!.url).toBe('https://www.alexandria.cz/hotel/big?ages=1_20&autofixes=T');
    expect(offers[0]!.url.length).toBeLessThan(200);
  });

  it('still honours a plausible multi-person party (persons=4)', () => {
    const offers = parseAlexandria({
      packages: [
        { tour_id: 'FAM', tour_name: 'Family', detail: 'fam', autofixes: 'T', start: '2026-08-01', nights: 7, persons: 4, package_price: 40000 },
      ],
    });
    expect(offers[0]!.pricePerPerson).toBe(10000);
    expect(offers[0]!.url).toBe(
      'https://www.alexandria.cz/hotel/fam?ages=1_20%7C2_20%7C3_20%7C4_20&autofixes=T',
    );
  });

  it('drops a row whose per-person price rounds to 0 rather than emitting a 0 CZK offer', () => {
    const offers = parseAlexandria({
      packages: [
        { tour_id: 'Z', tour_name: 'Sub-koruna', detail: 'z', start: '2026-08-01', nights: 7, persons: 2, package_price: 0.4 },
      ],
    });
    expect(offers).toEqual([]);
  });

  it('uses the /vyhledavani fallback url when the detail slug is missing', () => {
    const offers = parseAlexandria({
      packages: [
        { tour_id: 'F', tour_name: 'No slug', start: '2026-07-08', nights: 7, persons: 2, package_price: 30000 },
      ],
    });
    expect(offers.length).toBe(1);
    expect(offers[0]!.url).toBe('https://www.alexandria.cz/vyhledavani');
  });

  it('emits a bare /hotel/<detail> url when the row carries no autofixes term', () => {
    const offers = parseAlexandria({
      packages: [
        { tour_id: 'G', tour_name: 'No term', detail: 'g-slug', start: '2026-07-08', nights: 7, persons: 2, package_price: 30000 },
      ],
    });
    expect(offers[0]!.url).toBe('https://www.alexandria.cz/hotel/g-slug');
  });

  it('floors 4.5 stars to 4 and leaves category 0 as null', () => {
    const offers = parseAlexandria({
      packages: [
        { tour_id: 'H', tour_name: 'Superior', detail: 'h', start: '2026-07-08', nights: 7, persons: 2, package_price: 30000, accommodation_category: 4.5 },
        { tour_id: 'I', tour_name: 'Uncategorised', detail: 'i', start: '2026-07-08', nights: 7, persons: 2, package_price: 30000, accommodation_category: 0 },
      ],
    });
    expect(offers[0]!.stars).toBe(4);
    expect(offers[1]!.stars).toBeNull();
  });

  it('dedupes packages sharing the same sourceOfferKey within one response', () => {
    const pk = (page1Fixture as { packages: unknown[] }).packages;
    const doubled = { packages: [...pk, pk[0]] };
    expect(parseAlexandria(doubled).length).toBe(18);
  });

  it('nulls BOTH claimed fields when the discount pct rounds to 0 (original barely above package)', () => {
    // original_price 10040 vs package_price 10000 -> pct = round((40/10040)*100) = round(0.398) = 0.
    // Guard 0<pct<100 (like deluxea/datour): a 0%-rounded discount leaves BOTH claimed fields null,
    // never a non-null claimedOriginalPrice paired with a 0% claimedDiscountPct.
    const offers = parseAlexandria({
      packages: [
        { tour_id: 'P', tour_name: 'Tiny discount', detail: 'p', start: '2026-07-08', nights: 7, persons: 2, package_price: 10000, original_price: 10040 },
      ],
    });
    expect(offers.length).toBe(1);
    expect(offers[0]!.claimedDiscountPct).toBeNull();
    expect(offers[0]!.claimedOriginalPrice).toBeNull();
  });
});

describe('alexandria request budget', () => {
  const API = 'https://bck-new.alexandria.cz/web-search';

  it('caps the scan at 13 requests: 6 feed pages of 200 + 7 exotic locations', () => {
    // The budget guard. src/core/run.ts aborts an adapter after ADAPTER_FETCH_TIMEOUT_MS = 240s and
    // HttpClient serialises same-host requests 3s apart, so this ceiling is what keeps alexandria
    // from being recorded 'failed' (which would drop the whole source off the board).
    const queries = buildQueries();
    expect(queries.length).toBe(13);
    expect(queries.length).toBeLessThanOrEqual(13);

    const feed = queries.filter((q) => q.kind === 'feed');
    expect(feed.length).toBe(6);
    for (let page = 1; page <= 6; page += 1) {
      expect(feed[page - 1]!.url).toBe(`${API}?page=${page}&page_size=200`);
    }

    const exotic = queries.filter((q) => q.kind === 'exotic');
    expect(exotic.length).toBe(7);
    for (const id of ['3175', '8288', '3030', '5899', '3163', '453555', '453246']) {
      expect(exotic.map((q) => q.url)).toContain(`${API}?page=1&page_size=200&location=${id}`);
    }
  });

  it('asks for page_size=200 on every request (the only honoured page-width param)', () => {
    expect(buildQueries().every((q) => q.url.includes('page_size=200'))).toBe(true);
  });
});

describe('alexandria source adapter', () => {
  const API = 'https://bck-new.alexandria.cz/web-search';

  function makeCtx(jsonImpl: (url?: string) => Promise<unknown>): {
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

  const empty = { packages: [], total: 0 };

  // Default feed: page 1 -> page1 fixture, page 2 -> the Worldee tail, page 3 -> Itálie (zima);
  // pages 4-6 replay page 1 so the feed never looks exhausted (they contribute nothing new — which
  // also exercises the cross-page dedup). Bali location -> bali fixture; every other exotic
  // location -> the empty (seasonal) response.
  function standardImpl(url?: string): Promise<unknown> {
    if (url && url.includes('location=453246')) return Promise.resolve(baliFixture);
    if (url && url.includes('location=')) return Promise.resolve(maledivyFixture);
    if (url && url.includes('page=2&')) return Promise.resolve(tailFixture);
    if (url && url.includes('page=3&')) return Promise.resolve(zimaFixture);
    return Promise.resolve(page1Fixture);
  }

  it('is named alexandria and issues the full bounded query set', async () => {
    const { ctx, jsonMock } = makeCtx(standardImpl);
    const offers = await alexandria.fetchOffers(ctx);

    expect(alexandria.name).toBe('alexandria');
    // 6 feed pages + 7 exotic = 13, the documented hard cap.
    expect(jsonMock).toHaveBeenCalledTimes(13);

    const urls = jsonMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain(`${API}?page=1&page_size=200`);
    expect(urls).toContain(`${API}?page=6&page_size=200`);
    for (const id of ['3175', '8288', '3030', '5899', '3163', '453555', '453246']) {
      expect(urls).toContain(`${API}?page=1&page_size=200&location=${id}`);
    }
    expect(offers.every((o) => o.source === 'alexandria')).toBe(true);
    // 18 (p1) + 19 (tail) + 41 (zima) + 10 (Bali) = 88.
    expect(offers.length).toBe(88);
    expect(offers.some((o) => o.country === 'Indonésie')).toBe(true);
    expect(offers.some((o) => o.country === 'Bulharsko')).toBe(true);
    expect(offers.some((o) => o.country === 'Itálie')).toBe(true);
    expect(offers.some((o) => o.transport === 'own')).toBe(true);
  });

  it('stops paging the feed at the first empty page but still runs the exotic queries', async () => {
    // Paging past the end of the catalogue is pure waste: once a feed page comes back with zero
    // rows the remaining feed pages are skipped, while the (independent) exotic feeds still run.
    const { ctx, jsonMock } = makeCtx((url?: string) => {
      if (url && url.includes('location=')) return Promise.resolve(empty);
      if (url && url.includes('page=1&')) return Promise.resolve(page1Fixture);
      return Promise.resolve(empty); // page 2 empty -> pages 3..6 must never be requested
    });
    const offers = await alexandria.fetchOffers(ctx);

    const urls = jsonMock.mock.calls.map((c) => c[0] as string);
    expect(urls.filter((u) => !u.includes('location=')).length).toBe(2); // p1 + the empty p2 only
    expect(urls).not.toContain(`${API}?page=3&page_size=200`);
    expect(jsonMock).toHaveBeenCalledTimes(2 + 7);
    expect(offers.length).toBe(18);
  });

  it('dedupes offers across queries by sourceOfferKey', async () => {
    const { ctx } = makeCtx(standardImpl);
    const offers = await alexandria.fetchOffers(ctx);
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
    const offers = await alexandria.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
  });

  it('a failed feed page does not count as "past the end" (paging continues)', async () => {
    // A network error on page 2 must not be mistaken for an empty page — pages 3..6 still run.
    const { ctx, jsonMock } = makeCtx((url?: string) => {
      if (url && url.includes('page=2&')) return Promise.reject(new Error('network blip'));
      return standardImpl(url);
    });
    await alexandria.fetchOffers(ctx);
    const urls = jsonMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain(`${API}?page=3&page_size=200`);
  });

  it('stops issuing further queries on SourceBlockedError but keeps offers already collected', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    let n = 0;
    const { ctx, jsonMock } = makeCtx((url?: string) => {
      n += 1;
      if (n === 1) return standardImpl(url); // page1 -> 18 offers
      if (n === 2) return Promise.reject(new SourceBlockedError(403, 'blocked'));
      return standardImpl(url);
    });
    const offers = await alexandria.fetchOffers(ctx);
    expect(offers.length).toBe(18);
    expect(jsonMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows when ALL queries fail so runScan marks the source failed', async () => {
    const { ctx } = makeCtx(() => Promise.reject(new Error('total outage')));
    await expect(alexandria.fetchOffers(ctx)).rejects.toThrow('total outage');
  });

  it('rethrows when the FIRST query is blocked before any success (backoff must engage)', async () => {
    // Regression: a block on the very first query must propagate (not swallow to []), so runScan
    // writes the BLOCKED marker and the 24h backoff engages. The blocked branch must set lastError.
    const { SourceBlockedError } = await import('../src/core/http.js');
    const { ctx } = makeCtx(() => Promise.reject(new SourceBlockedError(403, 'blocked')));
    await expect(alexandria.fetchOffers(ctx)).rejects.toThrow('blocked');
  });

  it('does NOT throw when every query legitimately returns an empty catalogue', async () => {
    const { ctx } = makeCtx(() => Promise.resolve(empty));
    await expect(alexandria.fetchOffers(ctx)).resolves.toEqual([]);
  });

  it('logs the final summary line', async () => {
    const { ctx } = makeCtx(standardImpl);
    const logMock = ctx.log as ReturnType<typeof vi.fn>;
    await alexandria.fetchOffers(ctx);
    const logged = logMock.mock.calls.map((c) => c[0] as string);
    expect(logged.some((l) => /^alexandria: fetched \d+ offers across \d+ queries$/.test(l))).toBe(true);
  });
});
