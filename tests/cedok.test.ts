import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCedokListing, cedok } from '../src/sources/cedok.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, 'fixtures/cedok/last-minute-p1.html'), 'utf-8');
const reckoFixture = readFileSync(join(__dirname, 'fixtures/cedok/last-minute-recko.html'), 'utf-8');

/**
 * Builds a minimal synthetic card fragment mirroring the real Cedok DOM structure (the
 * `data-testid` selectors and icon classes are copied verbatim from the first card in
 * `tests/fixtures/cedok/last-minute-p1.html`), so tests can target specific parsing edge
 * cases without depending on the full ~700KB real fixture.
 */
function buildCard(opts: {
  hotelCode: string;
  title: string;
  dateText: string; // e.g. "05.07 - 06.07.2026 (2 dny)"
  price: string; // e.g. "880 Kč"
  basePrice?: string | null;
  country?: string;
  locality?: string;
  stars?: number;
  transportText?: string;
  boardText?: string;
}): string {
  const {
    hotelCode,
    title,
    dateText,
    price,
    basePrice = null,
    country = 'Česká republika',
    locality = 'Praha',
    stars = 3,
    transportText = 'Vlastní doprava',
    boardText = 'Snídaně',
  } = opts;

  const href = `/dovolena/ceska-republika/praha/hotel-slug,${hotelCode}/?id=XYZ`;
  const starsHtml = Array.from({ length: stars })
    .map(() => '<i class="icon icon-shape-star" role="listitem"></i>')
    .join('');
  const basePriceHtml = basePrice
    ? `<span data-testid="base-price" class="styles_price-base__6qZB_">${basePrice}</span>`
    : '';

  return `<div class="styles_c__f1i9i" role="button" tabindex="0" data-testid="offer-list-item">
    <div class="gallery"><a href="${href}"><img alt="${title}" data-testid="gallery-img" /></a></div>
    <div class="styles_c__content__Fu5Av">
      <header>
        <div class="styles_destination__tOoSF" data-testid="offer-list-item-destination">
          <a href="/last-minute/ceska-republika/">${country}</a>,&nbsp;<a href="/last-minute/praha/">${locality}</a>
        </div>
        <h3 class="styles_title__kH0gG"><a href="${href}">${title}</a></h3>
        <span role="list" data-testid="rating-stars">${starsHtml}</span>
      </header>
      <div class="mt-2">
        <div class="styles_c__GqLxf"><i class="icon icon-calendar"></i><span>${dateText}</span></div>
        <div>
          <span class="styles_label___8Mr4"><i class="icon icon-car-2"></i><span>${transportText}</span></span>
          <span class="styles_label___8Mr4"><i class="icon icon-cutlery-77"></i><span>${boardText}</span></span>
        </div>
      </div>
      <div data-testid="price">
        <div class="lh-1">
          ${basePriceHtml}
          <div data-testid="current-price" class="styles_price-current__3xvKZ"><span>${price}</span><span data-testid="suffix"> /os.</span></div>
        </div>
      </div>
      <a href="${href}">Zobrazit nabídku</a>
    </div>
  </div>`;
}

function wrapPage(cardsHtml: string): string {
  return `<!DOCTYPE html><html><head><title>test</title></head><body>${cardsHtml}</body></html>`;
}

function makeCtx(http: SourceContext['http']): SourceContext {
  return {
    http,
    adults: 2,
    log: vi.fn(),
  };
}

describe('parseCedokListing', () => {
  const offers = parseCedokListing(fixture);

  it('parses the real card count from the fixture (deduped: page renders each of the 25 offers twice)', () => {
    // The raw fixture contains 50 `[data-testid="offer-list-item"]` nodes, but they are
    // two renderings (mobile-width card + desktop "enlarged" card) of the SAME 25 offers.
    // The parser dedupes by sourceOfferKey (hash of hotel code + term details), so 25 is the
    // real count. Re-derived after the term-aware key change (Finding 2): still 25, because
    // the mobile/desktop duplicate of each card carries identical term data and no two
    // distinct offers in this fixture share both a hotel code and term.
    expect(offers.length).toBe(25);
  });

  it('parses the first offer with real values from the fixture', () => {
    const first = offers[0];
    expect(first).toBeDefined();
    expect(first!.title).toBe('Hotel Jelení Dvůr');
    expect(first!.country).toBe('Česká republika');
    expect(first!.locality).toBe('Praha');
    expect(first!.pricePerPerson).toBe(880);
    expect(first!.stars).toBe(3);
    expect(first!.transport).toBe('own');
    expect(first!.board).toBe('BB');
    expect(first!.nights).toBe(1);
    expect(first!.departureDate).toBe('2026-07-05');
    expect(first!.source).toBe('cedok');
    expect(first!.url).toBe(
      'https://www.cedok.cz/dovolena/ceska-republika/praha/hotel-jeleni-dvur,SCZ2VJD/?id=CgVDZWRvaxIEVklUQxoDQ1pLIgdTQ1oyVkpEKAM6BEtMMjZCBgiAvabSBkoGCIDgq9IGUAGSAQYIgL2m0gaaAQYIgOCr0gaiAQUKA0RCTKoBAwoBRvIBCQoHUmVzYWJlZQ%253D%253D',
    );
  });

  it('holds invariants for every offer', () => {
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(o.source).toBe('cedok');
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(Number.isInteger(o.pricePerPerson)).toBe(true);
      expect(o.url.startsWith('https://www.cedok.cz/')).toBe(true);
      expect(o.title.length).toBeGreaterThan(0);
      expect(o.sourceOfferKey.length).toBeGreaterThan(0);
    }
  });

  it('computes claimedDiscountPct/claimedOriginalPrice consistently for cards that carry a base-price', () => {
    // This fixture (priceAsc, page 1 = cheapest offers) happens to contain zero cards with a
    // base-price strike-through. The invariant below still guards the parser's behavior for
    // the general case, and degrades gracefully to "no cards" on this fixture. Real base-price
    // coverage lives in the `last-minute-recko.html` fixture tests below (Finding 4).
    const withOriginal = offers.filter((o) => o.claimedOriginalPrice !== null);
    for (const o of withOriginal) {
      expect(o.claimedOriginalPrice as number).toBeGreaterThan(o.pricePerPerson);
      expect(o.claimedDiscountPct).not.toBeNull();
      expect(o.claimedDiscountPct as number).toBeGreaterThan(0);
    }
  });

  it('deduplicates offers appearing in both mobile and desktop-enlarged card renderings', () => {
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('parseCedokListing: cross-year date ranges (Finding 1)', () => {
  it('assigns the departure year as (end year - 1) when the trip spans a year boundary', () => {
    const card = buildCard({
      hotelCode: 'XYEAR01',
      title: 'Cross Year Hotel',
      dateText: '28.12 - 04.01.2027 (8 dní)',
      price: '10 000 Kč',
    });
    const [offer] = parseCedokListing(wrapPage(card));
    expect(offer).toBeDefined();
    expect(offer!.departureDate).toBe('2026-12-28');
    expect(offer!.nights).toBe(7);
  });

  it('keeps the same year for a same-year date range', () => {
    const card = buildCard({
      hotelCode: 'SAMEYR1',
      title: 'Same Year Hotel',
      dateText: '15.07 - 22.07.2026 (8 dní)',
      price: '12 000 Kč',
    });
    const [offer] = parseCedokListing(wrapPage(card));
    expect(offer).toBeDefined();
    expect(offer!.departureDate).toBe('2026-07-15');
    expect(offer!.nights).toBe(7);
  });
});

describe('parseCedokListing: term-aware dedup key (Finding 2)', () => {
  it('keeps two offers for the same hotel code with different dates as distinct offers', () => {
    const cardA = buildCard({
      hotelCode: 'SAMEHTL',
      title: 'Same Hotel',
      dateText: '05.07 - 12.07.2026 (8 dní)',
      price: '10 000 Kč',
    });
    const cardB = buildCard({
      hotelCode: 'SAMEHTL',
      title: 'Same Hotel',
      dateText: '01.08 - 08.08.2026 (8 dní)',
      price: '11 000 Kč',
    });
    const offers = parseCedokListing(wrapPage(cardA + cardB));
    expect(offers.length).toBe(2);
    expect(new Set(offers.map((o) => o.sourceOfferKey)).size).toBe(2);
  });

  it('dedupes two byte-for-byte identical cards (mobile/desktop rendering) down to one offer', () => {
    const card = buildCard({
      hotelCode: 'SAMEHTL',
      title: 'Same Hotel',
      dateText: '05.07 - 12.07.2026 (8 dní)',
      price: '10 000 Kč',
    });
    const offers = parseCedokListing(wrapPage(card + card));
    expect(offers.length).toBe(1);
  });
});

describe('parseCedokListing: base-price coverage on a real fixture (Finding 4)', () => {
  const offers = parseCedokListing(reckoFixture);

  it('parses at least one offer with a base-price-derived discount', () => {
    const withDiscount = offers.filter(
      (o) => o.claimedOriginalPrice !== null && o.claimedOriginalPrice > o.pricePerPerson,
    );
    expect(withDiscount.length).toBeGreaterThan(0);
    for (const o of withDiscount) {
      expect(o.claimedDiscountPct).not.toBeNull();
      expect(o.claimedDiscountPct as number).toBeGreaterThanOrEqual(1);
      expect(o.claimedDiscountPct as number).toBeLessThanOrEqual(90);
    }
  });
});

describe('cedok.fetchOffers: per-page error isolation (Finding 3)', () => {
  it('continues past a generic error on one page and returns offers from the others', async () => {
    const cardFor = (hotelCode: string, title: string) =>
      wrapPage(
        buildCard({
          hotelCode,
          title,
          dateText: '05.07 - 12.07.2026 (8 dní)',
          price: '10 000 Kč',
        }),
      );

    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('page=1')) return cardFor('PAGE0001', 'Page 1 Hotel');
        if (url.includes('page=2')) throw new Error('network hiccup');
        if (url.includes('page=3')) return cardFor('PAGE0003', 'Page 3 Hotel');
        if (url.includes('page=4')) return cardFor('PAGE0004', 'Page 4 Hotel');
        throw new Error(`unexpected url ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await cedok.fetchOffers(ctx);

    expect(offers.map((o) => o.title).sort()).toEqual(['Page 1 Hotel', 'Page 3 Hotel', 'Page 4 Hotel'].sort());
    expect(http.text).toHaveBeenCalledTimes(4);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('page 2'));
  });

  it('stops pagination on SourceBlockedError but returns offers collected so far', async () => {
    const cardFor = (hotelCode: string, title: string) =>
      wrapPage(
        buildCard({
          hotelCode,
          title,
          dateText: '05.07 - 12.07.2026 (8 dní)',
          price: '10 000 Kč',
        }),
      );

    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('page=1')) return cardFor('PAGE0001', 'Page 1 Hotel');
        if (url.includes('page=2')) throw new SourceBlockedError(403, 'blocked');
        throw new Error(`should not fetch ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await cedok.fetchOffers(ctx);

    expect(offers.map((o) => o.title)).toEqual(['Page 1 Hotel']);
    // Only page 1 (success) and page 2 (blocked, then stop) should have been requested.
    expect(http.text).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the FIRST page is blocked before any success (backoff must engage)', async () => {
    // Regression: a block on page 1 (before any successful page) must propagate (not swallow to
    // []), so runScan writes the BLOCKED marker and the 24h backoff engages.
    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('page=1')) throw new SourceBlockedError(403, 'blocked');
        throw new Error(`should not fetch ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    await expect(cedok.fetchOffers(makeCtx(http))).rejects.toThrow('blocked');
    expect(http.text).toHaveBeenCalledTimes(1);
  });
});
