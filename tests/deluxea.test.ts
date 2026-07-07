import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDeluxeaListing, deluxea } from '../src/sources/deluxea.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const maledivyFixture = readFileSync(join(__dirname, 'fixtures/deluxea/hotely-maledivy.html'), 'utf-8');
const zanzibarFixture = readFileSync(join(__dirname, 'fixtures/deluxea/hotely-zanzibar.html'), 'utf-8');

const MALEDIVY_URL = 'https://www.deluxea.cz/hotely-maledivy/';
const ZANZIBAR_URL = 'https://www.deluxea.cz/hotely-zanzibar/';

function makeCtx(http: SourceContext['http']): SourceContext {
  return {
    http,
    adults: 2,
    log: vi.fn(),
  };
}

// --- Synthetic-card builders for the edge cases the live default listings never exhibit
// (no discount, "-" price placeholders, unknown destination-name). Shape mirrors the real
// fixture: a `.single-item` wrapper, an `<h2>` with the hotel-name anchor + `span.beutystar`
// + `span.destination-name`, a "Lokalita" row, and the `form.offline-data.hotel-comparator-form`
// carrying the offer JSON in `data-json` (single-quoted so the JSON's own double quotes survive).

interface BakedOpts {
  price?: string;
  total?: string;
  old?: string;
  meal?: string;
  date?: string;
  tickets?: string;
  company?: string;
}

function bakedJson(o: BakedOpts = {}): Record<string, unknown> {
  return {
    price: { '7': o.price ?? '37 690' },
    total: { '7': o.total ?? '71 130' },
    old_price: { '7': o.old ?? o.price ?? '37 690' },
    old_total: { '7': 0 },
    diff_total: { '7': '0' },
    meal: { '7': o.meal ?? 'Snídaně' },
    date_from: { '7': o.date ?? '10.09.2026' },
    date_to: { '7': '19.09.2026' },
    days: { '7': 10 },
    tickets: { '7': o.tickets ?? '16 800' },
    tickets_company_name: { '7': o.company ?? 'Etihad Airways' },
  };
}

interface CardOpts {
  href?: string;
  name?: string;
  stars?: number;
  dest?: string;
  locality?: string;
  json?: Record<string, unknown> | null;
}

function card(o: CardOpts = {}): string {
  const href = o.href ?? '/maledivy/hotel-test/';
  const name = o.name ?? 'Test Hotel';
  const stars = o.stars ?? 5;
  const dest = o.dest ?? 'Maledivy';
  const locality = o.locality ?? 'Maledivy, Somewhere';
  const dataJson = o.json === null ? '' : `data-json='${JSON.stringify(o.json ?? bakedJson())}'`;
  return `
    <div class="single-item">
      <article class="zajezd hotels">
        <h2><a href="${href}" class="comparator-link-to-hotel-params">${name} <span class="beutystar">${'*'.repeat(stars)}</span></a> <span class="destination-delimiter">|</span> <span class="destination-name">${dest}</span></h2>
        <div class="inner"><div class="fl two-rows">
          <p><span class="loc">Lokalita: </span><strong>${locality}</strong></p>
        </div></div>
        <form action="/hotely/" method="post" class=" offline-data hotel-comparator-form " ${dataJson}></form>
      </article>
    </div>`;
}

function page(cards: string[]): string {
  return `<html><body><div id="snippet--hotel_list">${cards.join('')}</div></body></html>`;
}

describe('parseDeluxeaListing: hotely-maledivy fixture (real, fully-baked prices)', () => {
  const offers = parseDeluxeaListing(maledivyFixture, MALEDIVY_URL);

  it('parses all 8 hotel cards (the 9th placeholder single-item has no offer form)', () => {
    expect(offers.length).toBe(8);
  });

  it('parses the first card with the real values from the embedded data-json + static HTML', () => {
    const first = offers[0];
    expect(first).toBeDefined();
    expect(first!.title).toBe('Seaside Finolhu Baa Atoll Maldives');
    expect(first!.source).toBe('deluxea');
    expect(first!.country).toBe('Maledivy');
    expect(first!.locality).toBe('Maledivy, Baa atoll');
    expect(first!.stars).toBe(5);
    expect(first!.board).toBe('BB'); // "Snídaně"
    expect(first!.transport).toBe('flight'); // tickets "16 800" / Etihad Airways present
    expect(first!.nights).toBe(7); // key of the price dict
    expect(first!.pricePerPerson).toBe(37690); // "37 690" (space thousands)
    expect(first!.priceTotal).toBe(71130); // total "71 130"
    expect(first!.departureDate).toBe('2026-09-10'); // date_from "10.09.2026"
    expect(first!.claimedOriginalPrice).toBeNull(); // old_price == price on this page
    expect(first!.claimedDiscountPct).toBeNull();
    expect(first!.url).toBe('https://www.deluxea.cz/maledivy/hotel-finolhu/');
  });

  it('holds shared invariants for every offer', () => {
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(o.source).toBe('deluxea');
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(Number.isInteger(o.pricePerPerson)).toBe(true);
      expect(o.url.startsWith('https://www.deluxea.cz/')).toBe(true);
      expect(o.title.length).toBeGreaterThan(0);
      expect(o.country).toBe('Maledivy');
      expect(o.transport).toBe('flight');
      expect(o.nights).toBe(7);
      expect(o.sourceOfferKey.length).toBeGreaterThan(0);
    }
  });

  it('never surfaces a discount on this page (old_price == price on every card)', () => {
    for (const o of offers) {
      expect(o.claimedOriginalPrice).toBeNull();
      expect(o.claimedDiscountPct).toBeNull();
    }
  });

  it('deduplicates by sourceOfferKey', () => {
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers a board mix including AI (All Inclusive cards present)', () => {
    const boards = new Set(offers.map((o) => o.board));
    expect(boards.has('AI')).toBe(true);
    expect(boards.has('BB')).toBe(true);
  });
});

describe('parseDeluxeaListing: hotely-zanzibar fixture (real, second country)', () => {
  const offers = parseDeluxeaListing(zanzibarFixture, ZANZIBAR_URL);

  it('parses all 8 hotel cards', () => {
    expect(offers.length).toBe(8);
  });

  it('parses the first card (Meliá Zanzibar) with real values', () => {
    const first = offers[0];
    expect(first).toBeDefined();
    expect(first!.title).toBe('Meliá Zanzibar');
    expect(first!.country).toBe('Zanzibar');
    expect(first!.stars).toBe(5);
    expect(first!.board).toBe('AI'); // "All Inclusive"
    expect(first!.transport).toBe('flight'); // Turkish Airlines
    expect(first!.nights).toBe(7);
    expect(first!.pricePerPerson).toBe(29690);
    expect(first!.priceTotal).toBe(54450);
    expect(first!.departureDate).toBe('2026-09-10');
    expect(first!.url).toBe('https://www.deluxea.cz/zanzibar/hotel-melia-zanzibar/');
  });

  it('assigns country Zanzibar to every offer and keeps invariants', () => {
    for (const o of offers) {
      expect(o.country).toBe('Zanzibar');
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(Number.isInteger(o.pricePerPerson)).toBe(true);
      expect(o.locality).not.toBeNull();
      expect(o.url.startsWith('https://www.deluxea.cz/')).toBe(true);
    }
  });
});

describe('parseDeluxeaListing: edge cases (synthetic cards)', () => {
  it('returns an empty array when the page has no hotel cards', () => {
    expect(parseDeluxeaListing('<html><body>nothing here</body></html>', MALEDIVY_URL)).toEqual([]);
  });

  it('skips cards whose data-json price is a "-" placeholder (price on demand)', () => {
    const html = page([
      card({ name: 'Priced Hotel', href: '/maledivy/hotel-a/', json: bakedJson({ price: '40 000' }) }),
      card({ name: 'On-demand Hotel', href: '/emiraty/hotel-b/', json: bakedJson({ price: '-', total: '-', old: '-' }) }),
    ]);
    const offers = parseDeluxeaListing(html, MALEDIVY_URL);
    expect(offers.length).toBe(1);
    expect(offers[0]!.title).toBe('Priced Hotel');
  });

  it('skips a card whose form carries no data-json at all', () => {
    const html = page([
      card({ name: 'Good', href: '/maledivy/hotel-good/' }),
      card({ name: 'Placeholder', href: '/maledivy/hotel-ghost/', json: null }),
    ]);
    const offers = parseDeluxeaListing(html, MALEDIVY_URL);
    expect(offers.map((o) => o.title)).toEqual(['Good']);
  });

  it('skips a card whose data-json is malformed JSON without throwing', () => {
    const bad = `
      <div class="single-item"><article class="zajezd hotels">
        <h2><a href="/x/y/">Broken <span class="beutystar">****</span></a> <span class="destination-name">Maledivy</span></h2>
        <form class="offline-data hotel-comparator-form" data-json='{not valid json'></form>
      </article></div>`;
    const html = page([card({ name: 'Fine', href: '/maledivy/hotel-fine/' }), bad]);
    const offers = parseDeluxeaListing(html, MALEDIVY_URL);
    expect(offers.map((o) => o.title)).toEqual(['Fine']);
  });

  it('derives claimedOriginalPrice/claimedDiscountPct when old_price > price', () => {
    const html = page([
      card({
        name: 'Discounted Hotel',
        href: '/maledivy/hotel-disc/',
        json: bakedJson({ price: '37 690', old: '45 000' }),
      }),
    ]);
    const offers = parseDeluxeaListing(html, MALEDIVY_URL);
    expect(offers.length).toBe(1);
    expect(offers[0]!.pricePerPerson).toBe(37690);
    expect(offers[0]!.claimedOriginalPrice).toBe(45000);
    // round((45000 - 37690) / 45000 * 100) = round(16.24) = 16
    expect(offers[0]!.claimedDiscountPct).toBe(16);
  });

  it('falls back to the listing-URL slug for country when destination-name is not a known country', () => {
    const html = page([
      card({ name: 'Slug Country Hotel', href: '/maledivy/hotel-slug/', dest: 'Baa Atoll' }),
    ]);
    const offers = parseDeluxeaListing(html, MALEDIVY_URL);
    expect(offers.length).toBe(1);
    expect(offers[0]!.country).toBe('Maledivy');
  });

  it('resolves the multi-word slug fallback (sri-lanka -> Srí Lanka)', () => {
    const html = page([
      card({ name: 'SL Hotel', href: '/sri-lanka/hotel-x/', dest: 'Some Beach' }),
    ]);
    const offers = parseDeluxeaListing(html, 'https://www.deluxea.cz/hotely-sri-lanka/');
    expect(offers.length).toBe(1);
    expect(offers[0]!.country).toBe('Srí Lanka');
  });

  it('marks transport unknown when no flight tickets are present', () => {
    const json = bakedJson();
    json.tickets = { '7': '' };
    json.tickets_company_name = { '7': '' };
    const html = page([card({ name: 'No Flight', href: '/maledivy/hotel-nf/', json })]);
    const offers = parseDeluxeaListing(html, MALEDIVY_URL);
    expect(offers.length).toBe(1);
    expect(offers[0]!.transport).toBe('unknown');
  });
});

describe('deluxea.fetchOffers: per-listing-URL error isolation', () => {
  it('continues past a generic error on one listing URL and returns offers from the others', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('hotely-maledivy')) {
          return page([card({ name: 'Maledivy Hotel', href: '/maledivy/hotel-m/' })]);
        }
        if (url.includes('hotely-zanzibar')) {
          throw new Error('network hiccup');
        }
        if (url.includes('hotely-mauricius')) {
          return page([card({ name: 'Mauricius Hotel', href: '/mauricius/hotel-mu/', dest: 'Mauricius' })]);
        }
        // every other listing URL yields nothing parseable
        return '<html><body></body></html>';
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await deluxea.fetchOffers(ctx);

    const titles = offers.map((o) => o.title).sort();
    expect(titles).toEqual(['Maledivy Hotel', 'Mauricius Hotel']);
    expect((ctx.log as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.stringContaining('zanzibar'));
  });

  it('stops working through remaining listing URLs on SourceBlockedError but keeps offers collected so far', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('hotely-maledivy')) {
          return page([card({ name: 'Maledivy Hotel', href: '/maledivy/hotel-m/' })]);
        }
        if (url.includes('hotely-emiraty')) {
          throw new SourceBlockedError(403, 'blocked');
        }
        throw new Error(`should not fetch ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await deluxea.fetchOffers(ctx);

    expect(offers.map((o) => o.title)).toEqual(['Maledivy Hotel']);
    // maledivy (ok) + emiraty (blocked) = 2 fetches, then stop
    expect((http.text as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('rethrows the last error when every listing URL fails', async () => {
    const http = {
      text: vi.fn(async () => {
        throw new Error('total outage');
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    await expect(deluxea.fetchOffers(ctx)).rejects.toThrow('total outage');
  });
});
