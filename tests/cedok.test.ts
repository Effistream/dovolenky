import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCedokListing, buildCedokUrls, cedok } from '../src/sources/cedok.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, 'fixtures/cedok/last-minute-p1.html'), 'utf-8');
const reckoFixture = readFileSync(join(__dirname, 'fixtures/cedok/last-minute-recko.html'), 'utf-8');
// Default-ordered (popularity) page 1, saved 2026-07-29 — the slice the adapter was blind to
// before the order=priceAsc fix: 7-night All-inclusive flight packages with a strike-through price.
const defaultFixture = readFileSync(join(__dirname, 'fixtures/cedok/last-minute-default-p1.html'), 'utf-8');

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
  transportIcon?: string; // icon class of the transport row, e.g. "icon-car-2" / "icon-airplane"
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
    transportIcon = 'icon-car-2',
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
          <span class="styles_label___8Mr4"><i class="icon ${transportIcon}"></i><span>${transportText}</span></span>
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
    expect(first!.departureAirport).toBeNull(); // own transport carries no airport
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
    // This fixture (priceAsc, page 1 = cheapest offers) contains zero cards with a base-price
    // strike-through — which is precisely the coverage defect the URL set now works around, and
    // why `last-minute-default-p1.html` exists. The invariant below still guards the parser's
    // behavior for the general case and degrades gracefully to "no cards" here.
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

describe('parseCedokListing: flight cards (Findings 5 + 6)', () => {
  it('maps an `icon-airplane` card to transport=flight (the old `[class*="icon-plane"]` selector never matched it)', () => {
    // Regression guard for the exact defect: "icon-airplane" does not contain the substring
    // "icon-plane", so the old selector returned nothing, the code fell back to the card text
    // ("Praha (letiště) 04:50"), and normalizeTransport — which looks for "letec"/"flight" —
    // resolved EVERY flight offer to 'unknown'.
    const card = buildCard({
      hotelCode: 'FLIGHT01',
      title: 'Flight Hotel',
      dateText: '05.08 - 12.08.2026 (8 dní)',
      price: '13 090 Kč',
      transportIcon: 'icon-airplane',
      transportText: 'Praha (letiště) 04:50',
      boardText: 'All inclusive',
    });
    const [offer] = parseCedokListing(wrapPage(card));
    expect(offer).toBeDefined();
    expect(offer!.transport).toBe('flight');
    expect(offer!.departureAirport).toBe('Praha');
    expect(offer!.board).toBe('AI');
  });

  it('strips the "(letiště)" qualifier and the departure time from the airport label', () => {
    const card = buildCard({
      hotelCode: 'FLIGHT02',
      title: 'Ostrava Hotel',
      dateText: '05.08 - 12.08.2026 (8 dní)',
      price: '13 090 Kč',
      transportIcon: 'icon-airplane',
      transportText: 'Ostrava (letiště) 08:00',
    });
    const [offer] = parseCedokListing(wrapPage(card));
    expect(offer!.departureAirport).toBe('Ostrava');
  });

  it('leaves departureAirport null for own-transport cards', () => {
    const card = buildCard({
      hotelCode: 'OWNCAR01',
      title: 'Own Transport Hotel',
      dateText: '05.08 - 07.08.2026 (3 dny)',
      price: '2 000 Kč',
    });
    const [offer] = parseCedokListing(wrapPage(card));
    expect(offer!.transport).toBe('own');
    expect(offer!.departureAirport).toBeNull();
  });

  it('maps every flight card in the real default-ordered fixture, with an airport on each', () => {
    const offers = parseCedokListing(defaultFixture);
    expect(offers.length).toBe(25);
    const flights = offers.filter((o) => o.transport === 'flight');
    // 20 of the 25 cards carry an `icon-airplane`; before the fix all 20 came out 'unknown'.
    expect(flights.length).toBe(20);
    expect(offers.filter((o) => o.transport === 'unknown').length).toBe(0);
    for (const o of flights) {
      expect(o.departureAirport).not.toBeNull();
      // City name only — no "(letiště)" qualifier, no time, so normalizeAirport can map it.
      expect(o.departureAirport as string).toMatch(/^[A-ZŘŠČŽÝÁÍÉŮÚĎŤŇ][^()0-9:]*$/);
    }
    expect(new Set(flights.map((o) => o.departureAirport))).toEqual(new Set(['Praha', 'Brno', 'Ostrava']));
  });

  it('maps the Zita Beach card exactly as its own detail page reads (live-verified 2026-07-29)', () => {
    // https://www.cedok.cz/dovolena/tunisko/djerba/hotel-zita-beach-resort,DJE2ZIT/ shows
    // "05.08 - 12.08.2026 (8 dní, 7 nocí) / Odlet: Ostrava (letiště), 08:00 / Strava: All
    // inclusive / 27 890 Kč -> 13 090 Kč / Celkem: 26 180 Kč" for 2 adults — i.e. the listing
    // price is genuinely per person, all-in, for the stated 7 nights.
    const offers = parseCedokListing(defaultFixture);
    const zita = offers.find((o) => o.url.includes('hotel-zita-beach-resort'));
    expect(zita).toBeDefined();
    expect(zita!.country).toBe('Tunisko');
    expect(zita!.locality).toBe('Djerba');
    expect(zita!.stars).toBe(4);
    expect(zita!.board).toBe('AI');
    expect(zita!.transport).toBe('flight');
    expect(zita!.departureAirport).toBe('Ostrava');
    expect(zita!.departureDate).toBe('2026-08-05');
    expect(zita!.nights).toBe(7);
    expect(zita!.pricePerPerson).toBe(13090);
    expect(zita!.claimedOriginalPrice).toBe(27890);
    expect(zita!.claimedDiscountPct).toBe(53);
  });

  it('recovers the discount signal the priceAsc slice was missing', () => {
    // The whole point of the URL change: on the default-ordered page 19 of 25 cards carry a
    // strike-through base-price, versus 0 of 25 on the priceAsc page the adapter used to fetch.
    const defaultOffers = parseCedokListing(defaultFixture);
    const priceAscOffers = parseCedokListing(fixture);
    expect(defaultOffers.filter((o) => o.claimedDiscountPct !== null).length).toBeGreaterThanOrEqual(15);
    expect(priceAscOffers.filter((o) => o.claimedDiscountPct !== null).length).toBe(0);
    // …and it is a different price band entirely (flight packages, not domestic weekend stays).
    expect(Math.min(...defaultOffers.map((o) => o.pricePerPerson))).toBeGreaterThan(
      Math.max(...priceAscOffers.map((o) => o.pricePerPerson)),
    );
  });
});

describe('buildCedokUrls: request budget + coverage mix (Findings 1-4)', () => {
  const urls = buildCedokUrls();

  it('stays inside the per-run request cap', () => {
    // run.ts aborts fetchOffers after 240 s and HttpClient spends ~4 s per URL, so the URL list
    // must stay well under ~40. MAX_REQUESTS is 30; blowing it flips the whole source to 'failed'.
    expect(urls.length).toBeLessThanOrEqual(30);
    expect(urls.length).toBeGreaterThan(4); // …and is materially more than the old 4-page run
  });

  it('issues every URL exactly once', () => {
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('fetches the default (popularity) ordering for the overview and every destination', () => {
    const nonPriceAsc = urls.filter((u) => !u.includes('order=priceAsc'));
    // Nothing but the deliberately-kept cheap tail may carry an `order` parameter: the default
    // ordering is what surfaces the discounted flight packages.
    expect(nonPriceAsc.every((u) => !u.includes('order='))).toBe(true);
    expect(nonPriceAsc.length).toBeGreaterThanOrEqual(20);
  });

  it('covers the seaside/exotic destinations the priceAsc-only run could never reach', () => {
    for (const slug of ['recko', 'turecko', 'egypt', 'spanelsko', 'kanarske-ostrovy', 'thajsko', 'tunisko']) {
      expect(urls.some((u) => u.includes(`/last-minute/${slug}/`))).toBe(true);
    }
  });

  it('still fetches the cheap domestic tail (order=priceAsc pages 1-4), last', () => {
    const cheap = urls.filter((u) => u.includes('order=priceAsc'));
    expect(cheap.length).toBe(4);
    expect(urls.slice(-4)).toEqual(cheap);
  });
});

describe('cedok.fetchOffers: per-URL error isolation (Finding 3)', () => {
  const cardFor = (hotelCode: string, title: string) =>
    wrapPage(
      buildCard({
        hotelCode,
        title,
        dateText: '05.07 - 12.07.2026 (8 dní)',
        price: '10 000 Kč',
      }),
    );

  it('requests exactly the planned URL list, once each (pagination cap)', async () => {
    const planned = buildCedokUrls();
    const http = {
      text: vi.fn(async (url: string) => cardFor(`H${planned.indexOf(url)}`, `Hotel ${planned.indexOf(url)}`)),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const offers = await cedok.fetchOffers(makeCtx(http));

    expect(http.text).toHaveBeenCalledTimes(planned.length);
    expect((http.text as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(planned);
    expect(offers.length).toBe(planned.length); // one distinct hotel per URL, nothing dropped
  });

  it('dedupes an offer that appears on two different URLs (overview vs destination page)', async () => {
    // The overview pages and the per-destination pages overlap BY CONSTRUCTION — the same hotel
    // term is on `/last-minute/?page=1` and on `/last-minute/recko/?page=1`. Without the
    // cross-URL `seen` set in fetchOffers the run would emit it twice, which ingest would then
    // have to collapse. Measured live 2026-07-29: 24 URLs x 25 cards = 600 raw -> 544 deduped.
    const planned = buildCedokUrls();
    const shared = cardFor('SHARED01', 'Shared Hotel');
    const http = {
      text: vi.fn(async (url: string) => {
        if (url === planned[0] || url === planned[1]) return shared;
        return cardFor(`H${planned.indexOf(url)}`, `Hotel ${planned.indexOf(url)}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const offers = await cedok.fetchOffers(makeCtx(http));

    expect(offers.filter((o) => o.title === 'Shared Hotel').length).toBe(1);
    expect(offers.length).toBe(planned.length - 1);
    expect(new Set(offers.map((o) => o.sourceOfferKey)).size).toBe(offers.length);
  });

  it('continues past a generic error on one URL and returns offers from the others', async () => {
    const planned = buildCedokUrls();
    const failing = planned[1]!;
    const http = {
      text: vi.fn(async (url: string) => {
        if (url === failing) throw new Error('network hiccup');
        return cardFor(`H${planned.indexOf(url)}`, `Hotel ${planned.indexOf(url)}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await cedok.fetchOffers(ctx);

    expect(http.text).toHaveBeenCalledTimes(planned.length);
    expect(offers.length).toBe(planned.length - 1);
    expect(offers.some((o) => o.title === 'Hotel 1')).toBe(false);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining(failing));
  });

  it('stops on SourceBlockedError but returns offers collected so far', async () => {
    const planned = buildCedokUrls();
    const http = {
      text: vi.fn(async (url: string) => {
        if (url === planned[0]) return cardFor('PAGE0001', 'Page 1 Hotel');
        if (url === planned[1]) throw new SourceBlockedError(403, 'blocked');
        throw new Error(`should not fetch ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await cedok.fetchOffers(ctx);

    expect(offers.map((o) => o.title)).toEqual(['Page 1 Hotel']);
    // Only URL 1 (success) and URL 2 (blocked, then stop) should have been requested.
    expect(http.text).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the FIRST URL is blocked before any success (backoff must engage)', async () => {
    // Regression: a block on the first URL (before any successful fetch) must propagate (not
    // swallow to []), so runScan writes the BLOCKED marker and the 24h backoff engages.
    const planned = buildCedokUrls();
    const http = {
      text: vi.fn(async (url: string) => {
        if (url === planned[0]) throw new SourceBlockedError(403, 'blocked');
        throw new Error(`should not fetch ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    await expect(cedok.fetchOffers(makeCtx(http))).rejects.toThrow('blocked');
    expect(http.text).toHaveBeenCalledTimes(1);
  });

  it('rethrows when EVERY URL fails (source must be recorded failed, not emptied)', async () => {
    const http = {
      text: vi.fn(async () => {
        throw new Error('total outage');
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    await expect(cedok.fetchOffers(makeCtx(http))).rejects.toThrow('total outage');
    expect(http.text).toHaveBeenCalledTimes(buildCedokUrls().length);
  });
});
