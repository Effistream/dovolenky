import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseDeluxeaListing,
  parseDeluxeaMaxPage,
  parseDeluxeaQuotedTerm,
  deluxea,
} from '../src/sources/deluxea.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/deluxea', name), 'utf-8');
const maledivyFixture = fixture('hotely-maledivy.html');
const maledivyP2Fixture = fixture('hotely-maledivy-p2.html');
const zanzibarFixture = fixture('hotely-zanzibar.html');
const kenaFixture = fixture('hotely-kena.html');

const MALEDIVY_URL = 'https://www.deluxea.cz/hotely-maledivy/';
const MALEDIVY_P2_URL = 'https://www.deluxea.cz/hotely/?destination=4&view=grid&num=2';
const ZANZIBAR_URL = 'https://www.deluxea.cz/hotely-zanzibar/';
const KENA_URL = 'https://www.deluxea.cz/hotely/?destination=67&view=grid&num=1';

function makeCtx(http: SourceContext['http']): SourceContext {
  return {
    http,
    adults: 2,
    log: vi.fn(),
  };
}

// --- Synthetic-card builders for the edge cases the live default listings never exhibit
// (a real discount, "-" price placeholders, unknown destination-name). Shape mirrors the real
// fixture: a `.single-item` wrapper, an `<h2>` with the hotel-name anchor + `span.beutystar`
// + `span.destination-name`, a "Lokalita" row, and the `form.offline-data.hotel-comparator-form`
// carrying the offer JSON in `data-json` (single-quoted so the JSON's own double quotes survive).

interface BakedOpts {
  price?: string;
  total?: string;
  old?: string;
  oldTotal?: string;
  meal?: string;
  date?: string;
  tickets?: string;
  company?: string;
  onDemand?: number;
}

function bakedJson(o: BakedOpts = {}): Record<string, unknown> {
  return {
    price: { '7': o.price ?? '37 690' },
    total: { '7': o.total ?? '71 130' },
    old_price: { '7': o.old ?? o.price ?? '37 690' },
    old_total: { '7': o.oldTotal ?? 0 },
    diff_total: { '7': '0' },
    price_on_demand: { '7': o.onDemand ?? 0 },
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

/** Mirrors the live `#snippet--paginator` block (session-bound `do=changeSide` links). */
function paginator(maxPage: number, destination = 4): string {
  const links = Array.from(
    { length: maxPage },
    (_, i) =>
      `<li><a class="ajax" href="/hotely/?num=${i + 1}&amp;view=grid&amp;destination=${destination}&amp;do=changeSide">${i + 1}</a></li>`,
  ).join('');
  return `<div id="snippet--paginator"><div class="pagination"><ul>${links}</ul></div></div>`;
}

function page(cards: string[], maxPage?: number): string {
  return `<html><body><div id="snippet--hotel_list">${cards.join('')}</div>${
    maxPage === undefined ? '' : paginator(maxPage)
  }</body></html>`;
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
    expect(first!.nights).toBe(7); // key of the price dict = hotel nights the price is quoted for
    expect(first!.pricePerPerson).toBe(71130); // total "71 130" — per-person ALL-IN (hotel+flight+transfer), not `price`
    expect(first!.priceTotal).toBeNull(); // `total` is per-person, so no honest party total is exposed
    expect(first!.claimedOriginalPrice).toBeNull(); // old_price == price on this page
    expect(first!.claimedDiscountPct).toBeNull();
    expect(first!.url).toBe('https://www.deluxea.cz/maledivy/hotel-finolhu/');
  });

  it('never emits a departureDate: date_from is the price calculator\'s default, not a term', () => {
    // The fixture (saved 2026-07-07) and every page fetched 2026-07-29 carry the identical
    // date_from 10.09.2026 on every card of every destination — it is the form default echoed into
    // data-json, and the site sells departures on any day ("Odlet každý den z Prahy nebo Vídně").
    expect(maledivyFixture).toContain('value="10.09.2026"');
    for (const o of offers) expect(o.departureDate).toBeNull();
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

describe('parseDeluxeaListing: hotely-maledivy page 2 (the paginated `?destination=&num=` URL)', () => {
  const p1 = parseDeluxeaListing(maledivyFixture, MALEDIVY_URL);
  const p2 = parseDeluxeaListing(maledivyP2Fixture, MALEDIVY_P2_URL);

  it('parses the 7 priced cards page 2 carries', () => {
    expect(p2.length).toBe(7);
  });

  it('maps Dusit Thani Maldives exactly as its own detail page prices it (live check 2026-07-29)', () => {
    // https://www.deluxea.cz/maledivy/hotel-dusit-thani-maldives/ own data-json:
    // price 32 370 + tickets 16 500 (Etihad) = total 49 470, meal Snídaně, 7 nights in hotel.
    const dusit = p2.find((o) => o.url.includes('hotel-dusit-thani-maldives'));
    expect(dusit).toBeDefined();
    expect(dusit!.title).toBe('Dusit Thani Maldives');
    expect(dusit!.pricePerPerson).toBe(49470);
    expect(dusit!.board).toBe('BB');
    expect(dusit!.nights).toBe(7);
    expect(dusit!.stars).toBe(5);
    expect(dusit!.country).toBe('Maledivy');
    expect(dusit!.locality).toBe('Maledivy, Baa atoll');
    expect(dusit!.departureDate).toBeNull();
  });

  it('is entirely new inventory: no hotel and no sourceOfferKey overlaps page 1', () => {
    const p1Keys = new Set(p1.map((o) => o.sourceOfferKey));
    expect(p2.filter((o) => p1Keys.has(o.sourceOfferKey))).toEqual([]);
    const p1Urls = new Set(p1.map((o) => o.url));
    expect(p2.filter((o) => p1Urls.has(o.url))).toEqual([]);
  });

  it('beats page 1 on price: page 2 holds the cheapest Maldives offer the site publishes', () => {
    const cheapestP1 = Math.min(...p1.map((o) => o.pricePerPerson));
    const cheapestP2 = Math.min(...p2.map((o) => o.pricePerPerson));
    expect(cheapestP2).toBeLessThan(cheapestP1); // 49 470 vs 57 760 — why page 1 alone is not enough
  });

  it('derives the country from the `?destination=<id>` URL when a card needs the fallback', () => {
    // No `/hotely-<slug>/` in this URL shape; the id must still resolve.
    const html = page([card({ name: 'Fallback', href: '/maledivy/hotel-fb/', dest: 'Baa Atoll' })]);
    const offers = parseDeluxeaListing(html, MALEDIVY_P2_URL);
    expect(offers[0]!.country).toBe('Maledivy');
  });
});

describe('parseDeluxeaListing: hotely-kena fixture (mixed priced / on-demand / calculator cards)', () => {
  const offers = parseDeluxeaListing(kenaFixture, KENA_URL);

  it('emits only the 4 cards that carry a baked price', () => {
    // The page holds 9 `.single-item` cards: 4 priced, 1 with price_on_demand=1, and 4 whose
    // comparator form is `calculate-me` with no data-json at all (priced only by a per-hotel AJAX
    // POST — outside the request budget, and shown by the site itself as "Cena na vyžádání").
    expect(kenaFixture.split('single-item').length - 1).toBeGreaterThanOrEqual(9);
    expect(kenaFixture).toContain('hotel-comparator-form calculate-me');
    expect(kenaFixture).toContain('comparator-price-on-demand-info');
    expect(offers.length).toBe(4);
  });

  it('maps a Keňa 4* All-Inclusive card', () => {
    const village = offers.find((o) => o.url.includes('hotel-neptune-village-beach'));
    expect(village).toBeDefined();
    expect(village!.title).toBe('Neptune Village Beach Resort & Spa');
    expect(village!.country).toBe('Keňa');
    expect(village!.locality).toBe('Keňa, Diani Beach');
    expect(village!.stars).toBe(4); // not every Deluxea property is a 5*
    expect(village!.board).toBe('AI'); // "All&nbsp;Inclusive"
    expect(village!.transport).toBe('flight'); // Ethiopian Airlines
    expect(village!.pricePerPerson).toBe(39750); // 17 010 hotel + 19 800 ticket + transfer
    expect(village!.departureDate).toBeNull();
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
    expect(first!.pricePerPerson).toBe(54450); // `total` (all-in per person), not `price` 29690
    expect(first!.priceTotal).toBeNull();
    expect(first!.departureDate).toBeNull();
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

  it('skips a card the site flags with price_on_demand even if a number survives in `total`', () => {
    const html = page([
      card({
        name: 'Flagged On-demand',
        href: '/maledivy/hotel-flag/',
        json: bakedJson({ price: '40 000', total: '71 130', onDemand: 1 }),
      }),
    ]);
    expect(parseDeluxeaListing(html, MALEDIVY_URL)).toEqual([]);
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

  it('derives claimedOriginalPrice/claimedDiscountPct from old_total (all-in) when it exceeds total', () => {
    const html = page([
      card({
        name: 'Discounted Hotel',
        href: '/maledivy/hotel-disc/',
        json: bakedJson({ total: '71 130', oldTotal: '85 000' }),
      }),
    ]);
    const offers = parseDeluxeaListing(html, MALEDIVY_URL);
    expect(offers.length).toBe(1);
    expect(offers[0]!.pricePerPerson).toBe(71130); // all-in total
    expect(offers[0]!.claimedOriginalPrice).toBe(85000);
    // round((85000 - 71130) / 85000 * 100) = round(16.32) = 16
    expect(offers[0]!.claimedDiscountPct).toBe(16);
  });

  it('keys an offer on hotel + nights only, so the calculator default date cannot churn it', () => {
    const a = parseDeluxeaListing(
      page([card({ href: '/maledivy/hotel-key/', json: bakedJson({ date: '10.09.2026' }) })]),
      MALEDIVY_URL,
    );
    const b = parseDeluxeaListing(
      page([card({ href: '/maledivy/hotel-key/', json: bakedJson({ date: '01.11.2026' }) })]),
      MALEDIVY_URL,
    );
    expect(a[0]!.sourceOfferKey).toBe(b[0]!.sourceOfferKey);
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

describe('parseDeluxeaMaxPage / parseDeluxeaQuotedTerm', () => {
  it('reads the highest page number off the live paginator', () => {
    expect(parseDeluxeaMaxPage(maledivyFixture)).toBe(12); // 95 Maldives hotels, 8 per page
    expect(parseDeluxeaMaxPage(maledivyP2Fixture)).toBe(12);
    expect(parseDeluxeaMaxPage(kenaFixture)).toBe(4);
  });

  it('returns null when a listing has no paginator (single-page destination)', () => {
    expect(parseDeluxeaMaxPage(page([card()]))).toBeNull();
  });

  it('reads the calculator default term the whole page is priced for', () => {
    expect(parseDeluxeaQuotedTerm(maledivyFixture)).toBe('2026-09-10');
    expect(parseDeluxeaQuotedTerm(kenaFixture)).toBe('2026-09-10');
    expect(parseDeluxeaQuotedTerm('<html></html>')).toBeNull();
  });
});

describe('deluxea.fetchOffers: paging and the request cap', () => {
  /** Distinct priced cards for every (destination, page) pair, so nothing ever dedupes away. */
  function endlessHttp(maxPage = 50) {
    return {
      text: vi.fn(async (url: string) => {
        const dest = new URL(url).searchParams.get('destination') ?? '0';
        const num = new URL(url).searchParams.get('num') ?? '1';
        return page(
          Array.from({ length: 8 }, (_, i) =>
            card({ name: `H ${dest}-${num}-${i}`, href: `/maledivy/hotel-${dest}-${num}-${i}/` }),
          ),
          maxPage,
        );
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
  }

  it('never exceeds the hard request budget even when every page keeps yielding', async () => {
    const http = endlessHttp();
    const ctx = makeCtx(http);
    const offers = await deluxea.fetchOffers(ctx);
    const calls = (http.text as ReturnType<typeof vi.fn>).mock.calls.length;
    // MAX_REQUESTS = 34: 34 requests x (3s host gap + ~1s fetch) stays well inside run.ts's
    // ADAPTER_FETCH_TIMEOUT_MS = 240s.
    expect(calls).toBe(34);
    expect(offers.length).toBe(34 * 8);
  });

  it('sweeps page 1 of every destination before going deeper (breadth first)', async () => {
    const http = endlessHttp();
    await deluxea.fetchOffers(makeCtx(http));
    const urls = (http.text as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    const firstNum2 = urls.findIndex((u) => u.includes('num=2'));
    const page1s = urls.slice(0, firstNum2);
    expect(page1s.every((u) => u.includes('num=1'))).toBe(true);
    expect(new Set(page1s.map((u) => new URL(u).searchParams.get('destination'))).size).toBe(page1s.length);
    expect(page1s.length).toBeGreaterThanOrEqual(13); // every configured destination is probed
  });

  it('uses the stateless `/hotely/?destination=<id>&view=grid&num=<n>` URL, never the session signal', async () => {
    const http = endlessHttp();
    await deluxea.fetchOffers(makeCtx(http));
    for (const [url] of (http.text as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/www\.deluxea\.cz\/hotely\/\?destination=\d+&view=grid&num=\d+$/);
      expect(String(url)).not.toContain('do=changeSide');
    }
  });

  it('stops paging a destination as soon as a page adds nothing new', async () => {
    // The other 12 destinations advertise a 1-page paginator so they retire on their own page 1.
    // That keeps the whole run far under MAX_REQUESTS, so the ONLY thing that can stop destination
    // 4 before its advertised page 5 is the added===0 rule — otherwise this test passes even with
    // the rule deleted, because the 34-request cap happens to truncate at the same page.
    const http = {
      text: vi.fn(async (url: string) => {
        const dest = new URL(url).searchParams.get('destination');
        const num = new URL(url).searchParams.get('num');
        if (dest !== '4') return page([], 1); // every other destination: one page, dead on the probe
        if (num === '1') return page([card({ href: '/maledivy/hotel-a/', name: 'A' })], 5);
        if (num === '2') return page([card({ href: '/maledivy/hotel-b/', name: 'B' })], 5);
        if (num === '3') return page([card({ href: '/maledivy/hotel-b/', name: 'B again' })], 5); // dupe only
        return page([card({ href: '/maledivy/hotel-c/', name: 'C' })], 5);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const offers = await deluxea.fetchOffers(makeCtx(http));
    expect(offers.map((o) => o.title)).toEqual(['A', 'B']); // 'C' on page 4 is never reached
    const calls = (http.text as ReturnType<typeof vi.fn>).mock.calls.map((c) => new URL(String(c[0])));
    expect(calls.length).toBeLessThan(20); // proves the request cap is NOT what stopped destination 4
    const nums = calls
      .filter((u) => u.searchParams.get('destination') === '4')
      .map((u) => u.searchParams.get('num'));
    expect(nums).toEqual(['1', '2', '3']); // pages 4 and 5 never requested, though the paginator offers them
  });

  it('never asks for a page beyond what the listing paginator advertises', async () => {
    const http = {
      text: vi.fn(async (url: string) =>
        page([card({ href: `/maledivy/hotel-${new URL(url).searchParams.get('num')}/` })], 2),
      ),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    await deluxea.fetchOffers(makeCtx(http));
    const nums = (http.text as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      Number(new URL(String(c[0])).searchParams.get('num')),
    );
    expect(Math.max(...nums)).toBe(2);
  });
});

describe('deluxea.fetchOffers: per-URL error isolation', () => {
  it('continues past a generic error on one destination and returns offers from the others', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        const dest = new URL(url).searchParams.get('destination');
        if (dest === '4') return page([card({ name: 'Maledivy Hotel', href: '/maledivy/hotel-m/' })]);
        if (dest === '16') throw new Error('network hiccup');
        if (dest === '2') {
          return page([card({ name: 'Mauricius Hotel', href: '/mauricius/hotel-mu/', dest: 'Mauricius' })]);
        }
        // every other destination yields nothing parseable
        return '<html><body></body></html>';
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await deluxea.fetchOffers(ctx);

    const titles = offers.map((o) => o.title).sort();
    expect(titles).toEqual(['Maledivy Hotel', 'Mauricius Hotel']);
    expect(ctx.log as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.stringContaining('destination=16'));
  });

  it('stops working through remaining requests on SourceBlockedError but keeps offers collected so far', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        const dest = new URL(url).searchParams.get('destination');
        if (dest === '4') return page([card({ name: 'Maledivy Hotel', href: '/maledivy/hotel-m/' })]);
        if (dest === '2') throw new SourceBlockedError(403, 'blocked');
        throw new Error(`should not fetch ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await deluxea.fetchOffers(ctx);

    expect(offers.map((o) => o.title)).toEqual(['Maledivy Hotel']);
    // maledivy (ok) + mauricius (blocked) = 2 fetches, then stop
    expect((http.text as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('rethrows the last error when every request fails', async () => {
    const http = {
      text: vi.fn(async () => {
        throw new Error('total outage');
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    await expect(deluxea.fetchOffers(ctx)).rejects.toThrow('total outage');
  });

  it('rethrows when the FIRST request is blocked before any success (backoff must engage)', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        if (new URL(url).searchParams.get('destination') === '4') throw new SourceBlockedError(403, 'blocked');
        throw new Error(`should not fetch ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    const ctx = makeCtx(http);
    // The CLASS matters, not just the message: run.ts:555 keys the BLOCKED_PREFIX marker (and with
    // it the 24 h backoff in blockedBackoffUntil) off `err instanceof SourceBlockedError`. Rewrapping
    // the block as a plain Error would still satisfy a message-only assertion while silently
    // downgrading a blocked source to an ordinary failure that gets retried every scan.
    await expect(deluxea.fetchOffers(ctx)).rejects.toThrow(SourceBlockedError);
    await expect(deluxea.fetchOffers(ctx)).rejects.toThrow('blocked');
    expect((http.text as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2); // one per fetchOffers call
  });

  it('warns in the log when the site\'s quoted term has gone past (prices would be stale)', async () => {
    const http = {
      text: vi.fn(async () => page([card({ json: bakedJson({ date: '01.01.2020' }) })])),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    const ctx = makeCtx(http);
    await deluxea.fetchOffers(ctx);
    expect(ctx.log as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.stringContaining('2020-01-01'));
  });
});
