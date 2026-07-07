import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEsoListing, esotravel } from '../src/sources/esotravel.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const maledivyFixture = readFileSync(join(__dirname, 'fixtures/esotravel/dovolena-maledivy.html'), 'utf-8');
const thajskoFixture = readFileSync(join(__dirname, 'fixtures/esotravel/dovolena-thajsko.html'), 'utf-8');
const lastMinuteFixture = readFileSync(join(__dirname, 'fixtures/esotravel/last-minute.html'), 'utf-8');

const BASE = 'https://www.esotravel.cz';
const NBSP = ' ';

function makeCtx(http: SourceContext['http']): SourceContext {
  return {
    http,
    adults: 2,
    log: vi.fn(),
  };
}

// --- Synthetic-card builder mirroring the real ESO markup: a `div.listview.primary`
// container with a `.visible` sub-block (tour-type + h2 + detail-date + term-price) and a
// `.hidden` sub-block (the alternate layout that also carries the board via `.popis
// i.fa-utensils`). Prices use the site's real U+00A0 thousands separator.
interface CardOpts {
  href?: string;
  name?: string;
  span?: string; // .tour-type span (country on last-minute, locality on country listings)
  type?: string; // "Poznávací zájezd" | "Pobytový zájezd" (may embed "letecky")
  stars?: number;
  date?: string; // detail-date text, e.g. "10. 08. - 25. 08. 2026"
  days?: string; // e.g. "16 dní / 14 nocí"
  price?: string | null; // strong text; null => no <strong> (na vyžádání)
  meal?: string | null; // .popis board token; null => no popis
  variant?: string; // extra class on the card container (pobyt-box / list-box)
}

function card(o: CardOpts = {}): string {
  const href = o.href ?? '/poznavaci/thajsko/some-tour/?termin=100001';
  const name = o.name ?? 'Some Tour';
  const span = o.span ?? 'Thajsko';
  const type = o.type ?? 'Poznávací zájezd';
  const stars = o.stars ?? 0;
  const date = o.date ?? '10. 08. - 25. 08. 2026';
  const days = o.days ?? '16 dní / 14 nocí';
  const starHtml = stars > 0 ? `<sup>${'<i class="fas fa-star"></i>'.repeat(stars)}</sup>` : '';
  const priceHtml =
    o.price === null
      ? ''
      : `<div class="price"><span>od</span> <strong>${o.price ?? `59${NBSP}490`}</strong>${NBSP}Kč</div>`;
  const popisHtml =
    o.meal === null || o.meal === undefined
      ? ''
      : `<div class="popis"><i class="fas fa-utensils"></i>${o.meal}<br><i class="fas fa-bed"></i>Room<br></div>`;
  return `
    <div class="listview primary ${o.variant ?? ''}">
      <div class="visible">
        <a target="_blank" href="${href}">
          <div class="tour-type"><i class="fab"></i>${type} | <span>${span}</span></div>
          <h2>${name} ${starHtml}</h2>
        </a>
        <div class="detail-date">
          <a target="_blank" href="${href}"><i class="fas fa-calendar-alt"></i> ${date}</a><br>
          <a class="other-dates" href="${href}#panel-terminy">+ další období (3)</a>
        </div>
        <a target="_blank" href="${href}" class="term-price">
          <span class="days">${days}</span>
          ${priceHtml}
        </a>
      </div>
      <div class="hidden">
        <a target="_blank" href="${href}">
          ${popisHtml}
        </a>
      </div>
    </div>`;
}

function page(cards: string[]): string {
  return `<html><body><div class="page-results grid-x">${cards.join('')}</div></body></html>`;
}

describe('parseEsoListing: dovolena-maledivy fixture (real, pobytové cards)', () => {
  const offers = parseEsoListing(maledivyFixture, 'Maledivy', BASE);

  it('parses all 15 pobytové cards', () => {
    expect(offers.length).toBe(15);
  });

  it('parses the first card with real values (incl. U+00A0 thousands separator)', () => {
    const first = offers[0]!;
    expect(first.source).toBe('esotravel');
    expect(first.title).toBe('Reethi Faru Resort'); // h2 <br> collapsed to a space
    expect(first.country).toBe('Maledivy'); // from the listing country param, not tour-type span
    expect(first.locality).toBe('Raa Atol'); // tour-type span (not a known country -> locality)
    expect(first.stars).toBe(4);
    expect(first.board).toBe('BB'); // .popis "snídaně"
    expect(first.transport).toBe('unknown'); // no "letecky" on the card
    expect(first.departureDate).toBe('2026-05-01'); // first date of range + trailing year
    expect(first.nights).toBe(7); // "10 dní / 7 nocí"
    expect(first.pricePerPerson).toBe(54990); // "54<U+00A0>990" -> parseCzk after NBSP normalization
    expect(first.priceTotal).toBeNull();
    expect(first.claimedOriginalPrice).toBeNull();
    expect(first.claimedDiscountPct).toBeNull();
    expect(first.omnibusLowestPrice).toBeNull();
    expect(first.url).toBe(`${BASE}/pobytove/maledivy/hotel/reethi-faru-resort-raa-atol/?ha=4439&zj=470`);
  });

  it('holds shared invariants for every offer', () => {
    for (const o of offers) {
      expect(o.source).toBe('esotravel');
      expect(o.country).toBe('Maledivy');
      expect(o.pricePerPerson).toBeGreaterThan(1000);
      expect(Number.isInteger(o.pricePerPerson)).toBe(true);
      expect(o.claimedOriginalPrice).toBeNull();
      expect(o.claimedDiscountPct).toBeNull();
      expect(o.url.startsWith(`${BASE}/`)).toBe(true);
      expect(o.title.length).toBeGreaterThan(0);
      expect(o.sourceOfferKey.length).toBeGreaterThan(0);
    }
  });

  it('extracts the full board mix from the pobytové .popis (secondary layout)', () => {
    const boards = new Set(offers.map((o) => o.board));
    expect(boards.has('BB')).toBe(true);
    expect(boards.has('FB')).toBe(true);
    expect(boards.has('AI')).toBe(true);
  });

  it('deduplicates by sourceOfferKey', () => {
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('parseEsoListing: dovolena-thajsko fixture (real, mixed poznávací + pobytové)', () => {
  const offers = parseEsoListing(thajskoFixture, 'Thajsko', BASE);

  it('parses 22 cards, skipping the one price-less/empty-termin card', () => {
    // 23 .listview.primary cards on the page; one ("Perly Jihočínského moře") has an
    // empty `?termin=` and no price -> skipped.
    expect(offers.length).toBe(22);
  });

  it('parses the first poznávací (touring) card, keyed by ?termin=', () => {
    const first = offers[0]!;
    expect(first.title).toBe('Thajskem k hranicím Myanmaru a odpočinkem u moře');
    expect(first.country).toBe('Thajsko');
    expect(first.locality).toBeNull(); // span "Thajsko" is a known country -> not a locality
    expect(first.nights).toBe(12); // "15 dní / 12 nocí"
    expect(first.departureDate).toBe('2026-10-30');
    expect(first.pricePerPerson).toBe(59490);
    expect(first.url).toBe(
      `${BASE}/poznavaci/thajsko/thajskem-k-hranicim-myanmaru-a-odpocinkem-u-more/?termin=2263802`,
    );
  });

  it('exercises both key strategies on one page (poznávací ?termin= and pobytové ?ha=)', () => {
    const hasTermin = offers.some((o) => o.url.includes('?termin='));
    const hasHa = offers.some((o) => o.url.includes('/pobytove/') && o.url.includes('ha='));
    expect(hasTermin).toBe(true);
    expect(hasHa).toBe(true);
  });

  it('assigns the country param to every offer and keeps prices sane', () => {
    for (const o of offers) {
      expect(o.country).toBe('Thajsko');
      expect(o.pricePerPerson).toBeGreaterThan(1000);
      expect(o.claimedOriginalPrice).toBeNull();
    }
  });
});

describe('parseEsoListing: last-minute fixture (country param null -> from .tour-type span)', () => {
  const offers = parseEsoListing(lastMinuteFixture, null, BASE);

  it('parses all 15 last-minute cards', () => {
    expect(offers.length).toBe(15);
  });

  it('derives country from the tour-type span gated by isKnownCountry', () => {
    const first = offers[0]!;
    expect(first.title).toBe('Americký západ - zlatý okruh');
    expect(first.country).toBeNull(); // "USA" is not in the recognized-country set
    expect(first.nights).toBe(14);
    expect(first.departureDate).toBe('2026-08-10');
    expect(first.pricePerPerson).toBe(88990);
    expect(first.url).toBe(`${BASE}/poznavaci/usa/americky-zapad-zlaty-okruh/?termin=2249820`);

    // A recognized country (e.g. Gruzie / Madeira / Egypt) resolves; unrecognized ones stay null.
    const known = offers.filter((o) => o.country !== null);
    const nulls = offers.filter((o) => o.country === null);
    expect(known.length).toBeGreaterThan(0);
    expect(nulls.length).toBeGreaterThan(0);
    for (const o of known) {
      expect(['Gruzie', 'Madeira', 'Egypt', 'Portugalsko']).toContain(o.country);
    }
  });

  it('never surfaces a claimed original price or discount (ESO has none)', () => {
    for (const o of offers) {
      expect(o.claimedOriginalPrice).toBeNull();
      expect(o.claimedDiscountPct).toBeNull();
    }
  });
});

describe('parseEsoListing: edge cases (synthetic cards)', () => {
  it('returns an empty array when the page has no cards', () => {
    expect(parseEsoListing('<html><body>nothing</body></html>', 'Thajsko', BASE)).toEqual([]);
  });

  it('skips a card whose price is absent ("na vyžádání")', () => {
    const html = page([
      card({ name: 'Priced', href: '/poznavaci/kuba/a/?termin=1', price: `40${NBSP}000` }),
      card({ name: 'On request', href: '/poznavaci/kuba/b/?termin=2', price: null }),
    ]);
    const offers = parseEsoListing(html, 'Kuba', BASE);
    expect(offers.map((o) => o.title)).toEqual(['Priced']);
  });

  it('always sets claimed* fields to null even on a fully-populated card', () => {
    const offers = parseEsoListing(page([card({ price: `50${NBSP}000` })]), 'Thajsko', BASE);
    expect(offers[0]!.claimedOriginalPrice).toBeNull();
    expect(offers[0]!.claimedDiscountPct).toBeNull();
    expect(offers[0]!.omnibusLowestPrice).toBeNull();
  });

  it('marks transport flight only when the tour-type clearly says letecky', () => {
    const flight = parseEsoListing(
      page([card({ type: 'Letecký poznávací zájezd', href: '/poznavaci/mexiko/x/?termin=9' })]),
      'Mexiko',
      BASE,
    );
    expect(flight[0]!.transport).toBe('flight');
    const unknown = parseEsoListing(page([card({ type: 'Poznávací zájezd' })]), 'Thajsko', BASE);
    expect(unknown[0]!.transport).toBe('unknown');
  });

  it('produces a price-independent sourceOfferKey (stable across price drops)', () => {
    // The whole point of ESO price-drop detection is our own snapshots keyed by sourceOfferKey,
    // so a price change MUST NOT change the key.
    const cheap = parseEsoListing(
      page([card({ href: '/poznavaci/kuba/z/?termin=555', price: `60${NBSP}000` })]),
      'Kuba',
      BASE,
    );
    const dropped = parseEsoListing(
      page([card({ href: '/poznavaci/kuba/z/?termin=555', price: `49${NBSP}000` })]),
      'Kuba',
      BASE,
    );
    expect(cheap[0]!.pricePerPerson).toBe(60000);
    expect(dropped[0]!.pricePerPerson).toBe(49000);
    expect(dropped[0]!.sourceOfferKey).toBe(cheap[0]!.sourceOfferKey);
  });

  it('keys pobytové cards (no ?termin=) stably by url path + ha + date + nights', () => {
    const a = parseEsoListing(
      page([card({ href: '/pobytove/maledivy/hotel/h/?ha=42&zj=470', variant: 'pobyt-box', price: `70${NBSP}000` })]),
      'Maledivy',
      BASE,
    );
    const b = parseEsoListing(
      page([card({ href: '/pobytove/maledivy/hotel/h/?ha=42&zj=470', variant: 'pobyt-box', price: `55${NBSP}000` })]),
      'Maledivy',
      BASE,
    );
    expect(a[0]!.sourceOfferKey).toBe(b[0]!.sourceOfferKey);
    expect(a[0]!.sourceOfferKey.length).toBeGreaterThan(0);
  });
});

describe('esotravel.fetchOffers: per-listing-URL error isolation', () => {
  it('fetches all 11 listing URLs (10 countries + last-minute)', async () => {
    const seen: string[] = [];
    const http = {
      text: vi.fn(async (url: string) => {
        seen.push(url);
        return '<html><body></body></html>';
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    await esotravel.fetchOffers(makeCtx(http));
    expect(seen.length).toBe(11);
    expect(seen.some((u) => u.includes('/last-minute/'))).toBe(true);
    expect(seen.some((u) => u.includes('/dovolena/maledivy/zajezdy/zajezdy/'))).toBe(true);
  });

  it('continues past a generic error on one listing URL and returns offers from the others', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('/dovolena/maledivy/')) {
          return page([card({ name: 'Maledivy Hotel', href: '/pobytove/maledivy/hotel/m/?ha=1&zj=470', variant: 'pobyt-box' })]);
        }
        if (url.includes('/dovolena/thajsko/')) {
          throw new Error('network hiccup');
        }
        if (url.includes('/dovolena/kuba/')) {
          return page([card({ name: 'Kuba Tour', href: '/poznavaci/kuba/k/?termin=7' })]);
        }
        return '<html><body></body></html>';
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await esotravel.fetchOffers(ctx);
    const titles = offers.map((o) => o.title).sort();
    expect(titles).toEqual(['Kuba Tour', 'Maledivy Hotel']);
    expect(ctx.log as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.stringContaining('thajsko'));
  });

  it('stops on SourceBlockedError but keeps offers collected so far', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('/dovolena/thajsko/')) {
          return page([card({ name: 'Thajsko Tour', href: '/poznavaci/thajsko/t/?termin=1' })]);
        }
        if (url.includes('/dovolena/maledivy/')) {
          throw new SourceBlockedError(403, 'blocked');
        }
        throw new Error(`should not fetch ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await esotravel.fetchOffers(ctx);
    expect(offers.map((o) => o.title)).toEqual(['Thajsko Tour']);
    // thajsko (ok) + maledivy (blocked) = 2 fetches, then stop
    expect((http.text as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('rethrows the last error when every listing URL fails', async () => {
    const http = {
      text: vi.fn(async () => {
        throw new Error('total outage');
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    await expect(esotravel.fetchOffers(makeCtx(http))).rejects.toThrow('total outage');
  });

  it('dedupes globally across listing pages by sourceOfferKey', async () => {
    // Same termin id surfaced on two different country listings -> one offer.
    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('/dovolena/thajsko/') || url.includes('/dovolena/kuba/')) {
          return page([card({ name: 'Shared Tour', href: '/poznavaci/asie/s/?termin=42' })]);
        }
        return '<html><body></body></html>';
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    const offers = await esotravel.fetchOffers(makeCtx(http));
    expect(offers.length).toBe(1);
  });
});
