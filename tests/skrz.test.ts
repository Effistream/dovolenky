import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSkrz, skrz } from '../src/sources/skrz.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reckoFixture = readFileSync(join(__dirname, 'fixtures/skrz/dovolena-more-recko.html'), 'utf-8');
const chorvatskoFixture = readFileSync(join(__dirname, 'fixtures/skrz/pobyty-chorvatsko.html'), 'utf-8');
// Region-facet page (…/destinace:recko:kreta), saved live 2026-07-29. Region facets are the
// adapter's depth lever — the server caps every listing at 24 deals and ignores offset — so this
// fixture pins that a region page is a normal listing page for the parser, with the same fields.
const kretaFixture = readFileSync(join(__dirname, 'fixtures/skrz/dovolena-more-recko-kreta.html'), 'utf-8');

function makeCtx(http: SourceContext['http']): SourceContext {
  return {
    http,
    adults: 2,
    log: vi.fn(),
  };
}

describe('parseSkrz: dovolena-more/destinace:recko fixture', () => {
  const offers = parseSkrz(reckoFixture);

  it('parses the real deal count from the fixture (24 deals/listing URL, no dupes)', () => {
    expect(offers.length).toBe(24);
  });

  it('parses the first offer with real values from the fixture', () => {
    const first = offers[0];
    expect(first).toBeDefined();
    // merchant.title is present on this deal, so it's preferred over the raw `title` field.
    expect(first!.title).toBe('Hotel Paralos Rodos Lifestyle');
    expect(first!.tourOperator).toBe('Blue-style.cz');
    expect(first!.country).toBe('Řecko');
    expect(first!.locality).toBe('Kolymbia');
    expect(first!.stars).toBe(4);
    expect(first!.board).toBe('AI');
    expect(first!.transport).toBe('flight');
    expect(first!.departureAirport).toBe('Praha');
    expect(first!.nights).toBe(7);
    expect(first!.priceTotal).toBeNull();
    expect(first!.pricePerPerson).toBe(19490); // persons: 1 => priceFinal unchanged
    expect(first!.claimedDiscountPct).toBe(44);
    expect(first!.claimedOriginalPrice).toBe(Math.round(19490 / (1 - 44 / 100)));
    expect(first!.departureDate).toBe('2026-10-03');
    expect(first!.source).toBe('skrz');
    expect(first!.url).toBe('https://skrz.cz/zajezd/paralos-rodos-lifestyle/VuYktP?dt=2026-10-03');
  });

  it('holds invariants for every offer', () => {
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(o.source).toBe('skrz');
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(Number.isInteger(o.pricePerPerson)).toBe(true);
      expect(o.url.startsWith('https://skrz.cz/')).toBe(true);
      expect(o.title.length).toBeGreaterThan(0);
      expect(o.sourceOfferKey.length).toBeGreaterThan(0);
    }
  });

  it('deduplicates by sourceOfferKey', () => {
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('populates tourOperator from serverTitle, including at least one Slevomat deal', () => {
    for (const o of offers) {
      expect(o.tourOperator).not.toBeNull();
    }
    const slevomat = offers.filter((o) => o.tourOperator === 'Slevomat');
    expect(slevomat.length).toBeGreaterThan(0);
  });

  it('assigns departureDate for deals whose detailUrl carries a ?dt= param', () => {
    const withDt = offers.filter((o) => o.url.includes('?dt='));
    expect(withDt.length).toBeGreaterThan(0);
    for (const o of withDt) {
      expect(o.departureDate).not.toBeNull();
      expect(o.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('leaves departureDate null for the voucher stay lacking ?dt=, while nights stays populated', () => {
    const voucher = offers.find((o) => o.url.includes('/voucher/'));
    expect(voucher).toBeDefined();
    expect(voucher!.departureDate).toBeNull();
    expect(voucher!.nights).not.toBeNull();
    expect(voucher!.tourOperator).toBe('Slevomat');
  });

  it('computes pricePerPerson via round(priceFinal/persons) when persons > 1', () => {
    // Every deal in the recko fixture has persons: 1, so pricePerPerson === priceFinal for all
    // of them; the multi-person division path is exercised by the Chorvatsko fixture below.
    for (const o of offers) {
      expect(o.pricePerPerson).toBeGreaterThan(0);
    }
  });
});

describe('parseSkrz: pobyty/destinace:chorvatsko fixture', () => {
  const offers = parseSkrz(chorvatskoFixture);

  it('parses the real deal count from the fixture', () => {
    expect(offers.length).toBe(24);
  });

  it('parses the first offer with real values from the fixture', () => {
    const first = offers[0];
    expect(first).toBeDefined();
    expect(first!.title).toBe('Resort Centinera');
    expect(first!.tourOperator).toBe('Slevomat');
    expect(first!.country).toBe('Chorvatsko');
    expect(first!.locality).toBe('Pula');
    expect(first!.stars).toBe(3);
    expect(first!.board).toBe('none');
    expect(first!.transport).toBe('own');
    expect(first!.departureAirport).toBeNull();
    expect(first!.nights).toBe(2);
    // priceFinal 4182, persons 2 => round(4182/2) = 2091
    expect(first!.pricePerPerson).toBe(2091);
    expect(first!.claimedDiscountPct).toBe(14);
    expect(first!.claimedOriginalPrice).toBe(Math.round(2091 / (1 - 14 / 100)));
    expect(first!.departureDate).toBeNull(); // stay has no ?dt= in detailUrl
    expect(first!.url).toBe('https://skrz.cz/zajezd/resort-centinera/CsGHCT');
  });

  it('holds invariants for every offer', () => {
    for (const o of offers) {
      expect(o.source).toBe('skrz');
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(Number.isInteger(o.pricePerPerson)).toBe(true);
      expect(o.url.startsWith('https://skrz.cz/')).toBe(true);
      expect(o.title.length).toBeGreaterThan(0);
    }
  });

  it('has multiple Slevomat deals, confirming Slevomat coverage flows through this adapter', () => {
    const slevomat = offers.filter((o) => o.tourOperator === 'Slevomat');
    expect(slevomat.length).toBeGreaterThan(1);
  });

  it('voucher-type stays (Slevomat vouchers) have null departureDate and populated nights', () => {
    const vouchers = offers.filter((o) => o.url.includes('/voucher/'));
    expect(vouchers.length).toBeGreaterThan(0);
    for (const v of vouchers) {
      expect(v.departureDate).toBeNull();
      expect(v.nights).not.toBeNull();
    }
  });
});

describe('parseSkrz: dovolena-more/destinace:recko:kreta region fixture', () => {
  const offers = parseSkrz(kretaFixture);

  it('parses a region-facet page exactly like a country page (24 deals, full field set)', () => {
    expect(offers.length).toBe(24);
    const first = offers[0];
    expect(first).toBeDefined();
    expect(first!.title).toBe('Vasia Village Hotel');
    expect(first!.country).toBe('Řecko');
    expect(first!.locality).toBe('Severní Kréta'); // deepest breadcrumb, i.e. the region's sub-zone
    expect(first!.stars).toBe(4);
    expect(first!.board).toBe('BB');
    expect(first!.transport).toBe('flight');
    expect(first!.departureAirport).toBe('Praha');
    expect(first!.departureDate).toBe('2026-09-17');
    expect(first!.nights).toBe(6);
    expect(first!.pricePerPerson).toBe(22990);
    expect(first!.claimedDiscountPct).toBe(32);
    expect(first!.claimedOriginalPrice).toBe(Math.round(22990 / (1 - 32 / 100)));
    expect(first!.tourOperator).toBe('Blue-style.cz');
    expect(first!.url).toBe('https://skrz.cz/zajezd/vasia-village-hotel/wCZpmj?dt=2026-09-17');
  });

  it('keeps every offer inside the parent country and holds the usual invariants', () => {
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const o of offers) {
      expect(o.country).toBe('Řecko');
      expect(o.source).toBe('skrz');
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(o.url.startsWith('https://skrz.cz/')).toBe(true);
    }
  });
});

describe('parseSkrz: edge cases', () => {
  it('returns an empty array when no deals payload and no ld+json Product blocks are present', () => {
    expect(parseSkrz('<html><body>nothing here</body></html>')).toEqual([]);
  });

  function wrapDeals(deals: unknown[]): string {
    const payload = JSON.stringify({ deals });
    const escaped = JSON.stringify(payload); // JSON-encode again so it round-trips through JSON.parse('"..."')
    return `<html><body><script>self.__next_f.push([1,${escaped}])</script></body></html>`;
  }

  let dealCounter = 0;
  function dealWithTitle(title: string): Record<string, unknown> {
    dealCounter += 1;
    const hash = `BRACKET${dealCounter}`;
    return {
      id: dealCounter,
      hash,
      title,
      serverTitle: 'Test.cz',
      priceFinal: 5000,
      discountInPercent: 10,
      detailUrl: `/zajezd/bracket-deal/${hash}`,
      breadcrumbs: { links: [{ title: 'Řecko' }] },
      board: 'all-inclusive',
      days: 8,
      nights: 7,
      persons: 1,
      transport: 'letecky',
      deptPlace: { title: 'Praha' },
      merchant: { title, stars: 3 },
    };
  }

  it('parses fully when a deal title contains "]:)" (lone closing bracket in free text)', () => {
    const html = wrapDeals([
      dealWithTitle('Last chance ]:) do not miss it'),
      dealWithTitle('Second deal after the bracketed one'),
    ]);
    const offers = parseSkrz(html);
    expect(offers.length).toBe(2);
    expect(offers[0]!.title).toBe('Last chance ]:) do not miss it');
    expect(offers[1]!.title).toBe('Second deal after the bracketed one');
  });

  it('parses fully when a deal title contains a lone "[" (opening bracket in free text)', () => {
    const html = wrapDeals([
      dealWithTitle('Special offer [limited] spots'),
      dealWithTitle('Second deal after the bracketed one'),
    ]);
    const offers = parseSkrz(html);
    expect(offers.length).toBe(2);
    expect(offers[0]!.title).toBe('Special offer [limited] spots');
    expect(offers[1]!.title).toBe('Second deal after the bracketed one');
  });

  it('parses fully when a deal title contains an escaped quote immediately followed by "]"', () => {
    const html = wrapDeals([
      dealWithTitle('The "best" deal ever"]'),
      dealWithTitle('Second deal after the bracketed one'),
    ]);
    const offers = parseSkrz(html);
    expect(offers.length).toBe(2);
    expect(offers[0]!.title).toBe('The "best" deal ever"]');
    expect(offers[1]!.title).toBe('Second deal after the bracketed one');
  });

  it('falls back to ld+json Product blocks when no RSC deals payload is present', () => {
    const html = `<html><body>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Fallback Hotel","image":"https://skrz.cz/img.webp","url":"https://skrz.cz/koupit/AbC123?dt=2026-08-01","offers":{"@type":"Offer","availability":"https://schema.org/InStock","price":"9999","priceCurrency":"CZK"}}</script>
    </body></html>`;
    const offers = parseSkrz(html);
    expect(offers.length).toBe(1);
    expect(offers[0]!.title).toBe('Fallback Hotel');
    expect(offers[0]!.pricePerPerson).toBe(9999);
    expect(offers[0]!.source).toBe('skrz');
    expect(offers[0]!.url).toBe('https://skrz.cz/koupit/AbC123?dt=2026-08-01');
    expect(offers[0]!.departureDate).toBe('2026-08-01');
  });

  it('maps skrz\'s "Česko" breadcrumb onto the canonical "Česká republika"', () => {
    // Audit finding #4: normalize.ts keys Czechia as "Česká republika"; skrz says "Česko", which
    // is not a COUNTRY_BY_KEY alias, so it used to pass through raw — a profile written as
    // countries: ["Česká republika"] would silently never match, and cross-source match keys
    // would not align with other adapters' spelling of the same country.
    function wrapDeals(deals: unknown[]): string {
      const escaped = JSON.stringify(JSON.stringify({ deals }));
      return `<html><body><script>self.__next_f.push([1,${escaped}])</script></body></html>`;
    }
    const html = wrapDeals([
      {
        id: 1,
        hash: 'CZ000001',
        title: 'Domácí wellness',
        serverTitle: 'Slevomat',
        priceFinal: 3000,
        discountInPercent: 20,
        detailUrl: '/voucher/CZ000001',
        breadcrumbs: { links: [{ title: 'Česko' }, { title: 'Krkonoše' }] },
        board: 'polopenze',
        days: 3,
        nights: 2,
        persons: 1,
        transport: 'vlastni-doprava',
        merchant: { title: 'Domácí wellness', stars: 4 },
      },
    ]);
    const offers = parseSkrz(html);
    expect(offers.length).toBe(1);
    expect(offers[0]!.country).toBe('Česká republika');
    expect(offers[0]!.locality).toBe('Krkonoše');
  });

  it('treats a 0% or 100%+ discount as absent (no claimedOriginalPrice)', () => {
    function wrapDeals(deals: unknown[]): string {
      const payload = JSON.stringify({ deals });
      const escaped = JSON.stringify(payload); // JSON-encode again so it round-trips through JSON.parse('"..."')
      return `<html><body><script>self.__next_f.push([1,${escaped}])</script></body></html>`;
    }
    const html = wrapDeals([
      {
        id: 1,
        hash: 'ZERO001',
        title: 'Zero Discount Deal',
        serverTitle: 'Test.cz',
        priceFinal: 5000,
        discountInPercent: 0,
        detailUrl: '/zajezd/zero-discount/ZERO001',
        breadcrumbs: { links: [{ title: 'Řecko' }] },
        board: 'all-inclusive',
        days: 8,
        nights: 7,
        persons: 1,
        transport: 'letecky',
        deptPlace: { title: 'Praha' },
        merchant: { title: 'Zero Discount Hotel', stars: 3 },
      },
    ]);
    const offers = parseSkrz(html);
    expect(offers.length).toBe(1);
    expect(offers[0]!.claimedDiscountPct).toBeNull();
    expect(offers[0]!.claimedOriginalPrice).toBeNull();
  });
});

function dealPayload(hash: string, title: string): string {
  const deals = [
    {
      id: 1,
      hash,
      title,
      serverTitle: 'Test.cz',
      priceFinal: 5000,
      discountInPercent: 10,
      detailUrl: `/zajezd/${hash}/${hash}?dt=2026-08-01`,
      breadcrumbs: { links: [{ title: 'Řecko' }] },
      board: 'all-inclusive',
      days: 8,
      nights: 7,
      persons: 1,
      transport: 'letecky',
      deptPlace: { title: 'Praha' },
      merchant: { title, stars: 3 },
    },
  ];
  const payload = JSON.stringify({ deals });
  const escaped = JSON.stringify(payload);
  return `<html><body><script>self.__next_f.push([1,${escaped}])</script></body></html>`;
}

/** One distinct deal per listing URL, so offer counts map 1:1 onto requests. */
function payloadForUrl(url: string): string {
  const slug = url.replace('https://skrz.cz/', '').replace(/[^a-z0-9]/gi, '');
  return dealPayload(slug, `Hotel ${slug}`);
}

function fakeHttp(
  handler: (url: string, init?: { signal?: AbortSignal }) => Promise<string>,
): SourceContext['http'] {
  return { text: vi.fn(handler), json: vi.fn() } as unknown as SourceContext['http'];
}

function requestedUrls(http: SourceContext['http']): string[] {
  return (http.text as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => c[0]);
}

describe('skrz.fetchOffers: request budget', () => {
  // src/core/run.ts aborts an adapter after ADAPTER_FETCH_TIMEOUT_MS = 240 s and records it
  // 'failed' — which deactivates every skrz offer on the board. HttpClient serializes same-host
  // requests 3 s apart, so the request count IS the wall clock: this cap is a safety property, not
  // a style preference. Measured live 2026-07-29: 40 requests → 154 s.
  const MAX_LISTING_URLS = 40;

  it('never issues more than the capped number of listing requests, all distinct', async () => {
    const http = fakeHttp(async (url) => payloadForUrl(url));
    const offers = await skrz.fetchOffers(makeCtx(http));

    const urls = requestedUrls(http);
    expect(urls.length).toBeLessThanOrEqual(MAX_LISTING_URLS);
    expect(new Set(urls).size).toBe(urls.length);
    for (const u of urls) expect(u.startsWith('https://skrz.cz/')).toBe(true);
    expect(offers.length).toBe(urls.length);
  });

  it('stops issuing requests once the wall-clock budget is spent, keeping what it has', async () => {
    // A hung host (25 s request timeout × 3 attempts) can blow the 240 s adapter timeout long
    // before the URL cap bites, so the loop also watches the clock. Simulated here by moving
    // Date.now forward 60 s per request: the 195 s budget must stop it after a handful of URLs.
    let clock = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const http = fakeHttp(async (url) => {
        clock += 60_000;
        return payloadForUrl(url);
      });
      const ctx = makeCtx(http);
      const offers = await skrz.fetchOffers(ctx);

      expect(requestedUrls(http).length).toBe(4); // 195 s budget / 60 s per request
      expect(offers.length).toBe(4); // partial result kept, not thrown away
      expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('budget'));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('aborts a hung request at the deadline instead of letting it overrun the adapter timeout', async () => {
    // The pre-request deadline check only bounds when a request may START. HttpClient will spend
    // up to ~80 s on one hung URL (3 s gap + 25 s × 3 attempts + backoff), so a request begun just
    // under the 195 s budget would return at ~275 s — past run.ts's 240 s abort, i.e. the exact
    // 'failed' outcome the budget exists to prevent. Each request must therefore carry an
    // AbortSignal for the remaining budget. Here the third URL hangs until aborted.
    vi.useFakeTimers();
    try {
      let calls = 0;
      const http = fakeHttp(async (url: string, init?: { signal?: AbortSignal }) => {
        calls += 1;
        if (calls !== 3) return payloadForUrl(url);
        const signal = init?.signal;
        expect(signal, 'adapter must pass an AbortSignal so a hung host cannot overrun').toBeInstanceOf(AbortSignal);
        return await new Promise<string>((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(new Error('aborted by budget')));
        });
      });

      const ctx = makeCtx(http);
      const promise = skrz.fetchOffers(ctx);
      // Walk the clock past the 195 s budget: the hung request must be aborted, not awaited forever.
      await vi.advanceTimersByTimeAsync(200_000);
      const offers = await promise;

      // Two good pages kept (partial beats aborted), the hung one abandoned, loop then stopped.
      expect(offers.length).toBe(2);
      expect(requestedUrls(http).length).toBe(3);
      expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('aborted by budget'));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('skrz.fetchOffers: destination coverage', () => {
  it('requests a listing URL for every country the watch profiles target', async () => {
    // Audit finding #1: nine destinations skrz itself lists returned ZERO offers because
    // LISTING_PATHS had no slug for them — including Španělsko, Itálie and Kypr, which the
    // leto-more profile explicitly watches, and SAE, which exotika watches.
    const http = fakeHttp(async (url) => payloadForUrl(url));
    await skrz.fetchOffers(makeCtx(http));
    const urls = requestedUrls(http);

    for (const slug of [
      'recko', 'turecko', 'egypt', 'spanelsko', 'kypr', 'bulharsko', 'chorvatsko', 'italie',
      'thajsko', 'maledivy', 'mauricius', 'spojene-arabske-emiraty', 'mexiko', 'kapverdy',
      'tunisko', 'portugalsko', 'malta', 'albanie',
    ]) {
      expect(urls, `missing destinace:${slug}`).toContain(`https://skrz.cz/dovolena-more/destinace:${slug}`);
    }
  });

  it('spends slots on region facets, the only way past the server-side 24-deal cap', async () => {
    const http = fakeHttp(async (url) => payloadForUrl(url));
    await skrz.fetchOffers(makeCtx(http));
    const regionUrls = requestedUrls(http).filter((u) => /destinace:[a-z-]+:[a-z-]+$/.test(u));
    expect(regionUrls.length).toBeGreaterThanOrEqual(10);
  });

  it('does not fetch the generic /pobyty catch-all', async () => {
    // Audit finding #3: that page returned 24 domestic 1–2 night stays, all with departureDate
    // null, i.e. zero profile matches — a wasted request at 3 s of the adapter's budget.
    const http = fakeHttp(async (url) => payloadForUrl(url));
    await skrz.fetchOffers(makeCtx(http));
    expect(requestedUrls(http).some((u) => u.endsWith('/pobyty'))).toBe(false);
  });

  it('never combines facets or sends params robots.txt disallows', async () => {
    // robots.txt disallows `*,` (combined facets), */cena:, */vyber:, */platnost:, */pocet-dni:,
    // /*?dt=, /koupit/ and 4+ path segments; alternate orderings live under /nejlevnejsi/ and
    // /nejvetsi-slevy/, so we always take the site's default ordering.
    const http = fakeHttp(async (url) => payloadForUrl(url));
    await skrz.fetchOffers(makeCtx(http));
    for (const u of requestedUrls(http)) {
      const path = new URL(u).pathname;
      expect(u).not.toContain(',');
      expect(u).not.toContain('?');
      expect(u).not.toMatch(/\/(cena|vyber|platnost|pocet-dni|nejlevnejsi|nejvetsi-slevy|koupit)/);
      expect(path.split('/').filter(Boolean).length).toBeLessThanOrEqual(3);
    }
  });
});

describe('skrz.fetchOffers: per-listing-URL error isolation', () => {
  it('continues past a generic error on one listing URL and returns offers from the others', async () => {
    const failing = 'https://skrz.cz/dovolena-more/destinace:turecko';
    const http = fakeHttp(async (url) => {
      if (url === failing) throw new Error('network hiccup');
      return payloadForUrl(url);
    });

    const ctx = makeCtx(http);
    const offers = await skrz.fetchOffers(ctx);

    const urls = requestedUrls(http);
    expect(urls).toContain(failing);
    expect(urls.length).toBeGreaterThan(30); // the failure did not sink the rest of the list
    expect(offers.length).toBe(urls.length - 1);
    const missingTitle = `Hotel ${failing.replace('https://skrz.cz/', '').replace(/[^a-z0-9]/gi, '')}`;
    expect(offers.some((o) => o.title === missingTitle)).toBe(false);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('turecko'));
  });

  it('stops working through remaining listing URLs on SourceBlockedError but keeps offers collected so far', async () => {
    let calls = 0;
    const http = fakeHttp(async (url) => {
      calls += 1;
      if (calls >= 3) throw new SourceBlockedError(403, 'blocked');
      return payloadForUrl(url);
    });

    const ctx = makeCtx(http);
    const offers = await skrz.fetchOffers(ctx);

    expect(offers.length).toBe(2);
    expect(requestedUrls(http).length).toBe(3); // stopped at the block, did not walk the rest
  });

  it('rethrows when the FIRST listing URL is blocked before any success (backoff must engage)', async () => {
    // Regression: a block on the very first listing URL must propagate (not swallow to []), so
    // runScan writes the BLOCKED marker and the 24h backoff engages.
    const http = fakeHttp(async () => {
      throw new SourceBlockedError(403, 'blocked');
    });
    await expect(skrz.fetchOffers(makeCtx(http))).rejects.toThrow('blocked');
    expect(requestedUrls(http).length).toBe(1);
  });

  it('rethrows when every listing URL fails with a generic error (never degrades to [])', async () => {
    const http = fakeHttp(async () => {
      throw new Error('network down');
    });
    await expect(skrz.fetchOffers(makeCtx(http))).rejects.toThrow('network down');
  });
});
