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

describe('skrz.fetchOffers: per-listing-URL error isolation', () => {
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

  it('continues past a generic error on one listing URL and returns offers from the others', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('destinace:recko')) return dealPayload('RECKO01', 'Recko Hotel');
        if (url.includes('destinace:turecko')) throw new Error('network hiccup');
        if (url.includes('destinace:egypt')) return dealPayload('EGYPT01', 'Egypt Hotel');
        if (url.includes('destinace:bulharsko')) return dealPayload('BULH0001', 'Bulharsko Hotel');
        if (url.includes('destinace:chorvatsko')) return dealPayload('CHORV001', 'Chorvatsko Hotel');
        if (url.endsWith('/pobyty')) return dealPayload('POBYTY01', 'Pobyty Hotel');
        throw new Error(`unexpected url ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await skrz.fetchOffers(ctx);

    expect(offers.map((o) => o.title).sort()).toEqual(
      ['Recko Hotel', 'Egypt Hotel', 'Bulharsko Hotel', 'Chorvatsko Hotel', 'Pobyty Hotel'].sort(),
    );
    expect(http.text).toHaveBeenCalledTimes(6);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('turecko'));
  });

  it('stops working through remaining listing URLs on SourceBlockedError but keeps offers collected so far', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('destinace:recko')) return dealPayload('RECKO01', 'Recko Hotel');
        if (url.includes('destinace:turecko')) throw new SourceBlockedError(403, 'blocked');
        throw new Error(`should not fetch ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await skrz.fetchOffers(ctx);

    expect(offers.map((o) => o.title)).toEqual(['Recko Hotel']);
    expect(http.text).toHaveBeenCalledTimes(2);
  });
});
