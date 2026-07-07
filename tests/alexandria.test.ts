import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAlexandria, alexandria } from '../src/sources/alexandria.js';
import { offerKeyHash } from '../src/core/normalize.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures/alexandria', name), 'utf-8'));
}

// Live fixtures captured 2026-07-07 (curl, Chrome UA, alexandria.cz has no anti-bot / permissive
// robots — spec §16.1 row 12). See .superpowers/sdd/task-36-report.md for the full evidence.
//  - web-search-page1.json: GET https://bck-new.alexandria.cz/web-search?page=1 (default feed):
//    18 packages, all currently discounted (original_price > package_price), Mediterranean
//    countries, board All Inclusive / Ultra All inclusive, transport Letecky. Proves the
//    per-person + discount math.
//  - web-search-bali.json: GET ...?page=1&location=453246 (Bali, exotic season fallback since
//    Maledivy 3175 is seasonally empty in July): 10 packages, country Indonésie, board mix
//    (Bez stravy / Snídaně), tour_id as "BV_xxx" strings, board_id null, and — critically —
//    original_price == package_price on every row, proving the no-discount guard.
//  - web-search-maledivy.json: GET ...?page=1&location=3175 → {packages:[], total:0}: the
//    seasonal-empty exotic location (winter product not yet on sale), proving empty → [].
const page1Fixture = loadFixture('web-search-page1.json');
const baliFixture = loadFixture('web-search-bali.json');
const maledivyFixture = loadFixture('web-search-maledivy.json');

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
    expect(first.url).toBe('https://www.alexandria.cz/hotel/4782-belvedere-alexandria-club');
  });

  it('rounds a fractional accommodation_category (3.5 -> 4 stars)', () => {
    // tour 9109 "Aguamarina Alexandria Club" has accommodation_category 3.5.
    const row = offers.find((o) => o.title === 'Aguamarina Alexandria Club')!;
    expect(row).toBeDefined();
    expect(row.stars).toBe(4);
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
    expect(first.url).toBe('https://www.alexandria.cz/hotel/BV_281-adi-dharma-hotel-kuta');
    // board_id is null on Bali rows -> hashed as '' by offerKeyHash.
    expect(first.sourceOfferKey).toBe(offerKeyHash(['BV_281', '2026-07-13', 7, null]));
  });

  it('normalizes "Snídaně" board to BB', () => {
    const bb = offers.find((o) => o.board === 'BB');
    expect(bb).toBeDefined();
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
        { tour_id: 'E', tour_name: 'No persons', detail: 'e', start: '2026-07-08', nights: 7, package_price: 20000 },
      ],
    });
    expect(offers.length).toBe(1);
    expect(offers[0]!.pricePerPerson).toBe(20000);
    expect(offers[0]!.priceTotal).toBe(20000);
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

  // Default feed (no location) -> page1 fixture; Bali location -> bali fixture; every other
  // exotic location -> the empty (seasonal) response.
  function standardImpl(url?: string): Promise<unknown> {
    if (url && url.includes('location=453246')) return Promise.resolve(baliFixture);
    if (url && url.includes('location=')) return Promise.resolve(maledivyFixture);
    return Promise.resolve(page1Fixture);
  }

  it('is named alexandria and issues 9 bounded queries (default pages 1-2 + 7 exotic locations)', async () => {
    const { ctx, jsonMock } = makeCtx(standardImpl);
    const offers = await alexandria.fetchOffers(ctx);

    expect(alexandria.name).toBe('alexandria');
    expect(jsonMock).toHaveBeenCalledTimes(9);
    expect(jsonMock.mock.calls.length).toBeLessThanOrEqual(10);

    const urls = jsonMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain(`${API}?page=1`);
    expect(urls).toContain(`${API}?page=2`);
    for (const id of ['3175', '8288', '3030', '5899', '3163', '453555', '453246']) {
      expect(urls).toContain(`${API}?page=1&location=${id}`);
    }
    expect(offers.every((o) => o.source === 'alexandria')).toBe(true);
    // 18 (default page1) + 0 (page2 dup, deduped) + 10 (Bali) + 0 (empty exotic) = 28.
    expect(offers.length).toBe(28);
    expect(offers.some((o) => o.country === 'Indonésie')).toBe(true);
    expect(offers.some((o) => o.country === 'Bulharsko')).toBe(true);
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

  it('logs the final summary line', async () => {
    const { ctx } = makeCtx(standardImpl);
    const logMock = ctx.log as ReturnType<typeof vi.fn>;
    await alexandria.fetchOffers(ctx);
    const logged = logMock.mock.calls.map((c) => c[0] as string);
    expect(logged.some((l) => /^alexandria: fetched \d+ offers across \d+ queries$/.test(l))).toBe(true);
  });
});
