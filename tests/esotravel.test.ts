import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEsoListing, esotravel } from '../src/sources/esotravel.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(__dirname, `fixtures/esotravel/${name}.html`), 'utf-8');

// /dovolena/zajezdy/ page 0, saved live 2026-07-29 — the site's GLOBAL catalogue page, which
// renders BOTH feed panels (poznávací + pobytové) in one response = 30 cards per request.
const katalogFixture = fixture('dovolena-zajezdy');
// /last-minute/?strana=1, saved live 2026-07-29 — a deep page that carries the site's own
// <!-- feed_end --> marker.
const lastMinuteP1Fixture = fixture('last-minute-strana1');
// 2026-07-07 country listings, kept as parser fixtures: they hold card shapes the catalogue page
// does not (season-priced Maldives stays, a Dec→Jan term, a price-less card, cross-listed cards).
const maledivyFixture = fixture('dovolena-maledivy');
const thajskoFixture = fixture('dovolena-thajsko');
const lastMinuteFixture = fixture('last-minute');

const BASE = 'https://www.esotravel.cz';
const NBSP = ' ';

function makeCtx(http: SourceContext['http']): SourceContext {
  return {
    http,
    adults: 2,
    log: vi.fn(),
  };
}

// --- Synthetic-card builder mirroring the real ESO markup: a `div.listview.primary`
// container with a `.visible` sub-block (tour-type + h2 + detail-date + term-price) and a
// `.hidden` sub-block (the alternate layout that also carries `.place` and the board via
// `.popis i.fa-utensils`). Prices use the site's real U+00A0 thousands separator.
interface CardOpts {
  href?: string;
  name?: string;
  span?: string; // .tour-type span (locality on stay cards, country on tour cards)
  place?: [string, string]; // .hidden .place <em>Country</em> | <em>Locality</em>
  type?: string; // "Poznávací zájezd" | "Pobytový zájezd"
  stars?: number;
  halfStar?: boolean;
  date?: string; // detail-date text, e.g. "10. 08. - 25. 08. 2026"
  days?: string; // e.g. "16 dní / 14 nocí"
  price?: string | null; // strong text; null => no <strong> (na vyžádání / vyprodáno)
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
  const starHtml =
    stars > 0 || o.halfStar === true
      ? `<sup>${'<i class="fas fa-star"></i>'.repeat(stars)}${o.halfStar === true ? '<i class="fas fa-star-half"></i>' : ''}</sup>`
      : '';
  const priceHtml =
    o.price === null
      ? ''
      : `<div class="price"><span>od</span> <strong>${o.price ?? `59${NBSP}490`}</strong>${NBSP}Kč</div>`;
  const popisHtml =
    o.meal === null || o.meal === undefined
      ? ''
      : `<div class="popis"><i class="fas fa-utensils"></i>${o.meal}<br><i class="fas fa-bed"></i>Room<br></div>`;
  const placeHtml =
    o.place === undefined ? '' : `<div class="place"><em>${o.place[0]}</em> | <em>${o.place[1]}</em></div>`;
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
          ${placeHtml}
          ${popisHtml}
        </a>
      </div>
    </div>`;
}

function page(cards: string[], opts: { feedEnd?: boolean } = {}): string {
  return `<html><body><div class="feed"><div class="page-results grid-x"><!-- startresults panel-feed-poznavaci -->${cards.join(
    '',
  )}${opts.feedEnd === true ? '<!-- feed_end -->' : ''}<!-- endresults --></div></div></body></html>`;
}

describe('parseEsoListing: /dovolena/zajezdy/ fixture (global catalogue, BOTH feed panels)', () => {
  const offers = parseEsoListing(katalogFixture, BASE);

  it('parses all 30 cards of the two panels served by ONE request', () => {
    // The coverage lever: the catalogue page renders panel-feed-poznavaci AND panel-feed-pobytove,
    // 15 cards each, and ?strana=N advances both — 30 offers per request instead of 15.
    expect((katalogFixture.match(/listview primary/g) ?? []).length).toBe(30);
    expect(offers.length).toBe(30);
    expect(offers.filter((o) => o.url.includes('/poznavaci/')).length).toBe(15);
    expect(offers.filter((o) => o.url.includes('/pobytove/')).length).toBe(15);
  });

  it('parses the first (touring) card with real values', () => {
    const first = offers[0]!;
    expect(first.source).toBe('esotravel');
    expect(first.title).toBe('Grónsko - ledovce a mýty Inuitů');
    expect(first.country).toBe('Grónsko');
    expect(first.departureDate).toBe('2026-08-06');
    expect(first.nights).toBe(9);
    expect(first.pricePerPerson).toBe(131000);
    expect(first.priceTotal).toBeNull();
    expect(first.url).toBe(`${BASE}/poznavaci/gronsko/gronsko-ledovce-a-myty-inuitu/?termin=858391`);
  });

  it('parses a stay card incl. locality and stars from the hidden layout', () => {
    const seaBreeze = offers.find((o) => o.url.includes('sea-breeze-resort-pattaya'))!;
    expect(seaBreeze.title).toBe('Sea Breeze Resort'); // h2 <br> collapsed to a space
    expect(seaBreeze.country).toBe('Thajsko');
    expect(seaBreeze.locality).toBe('Pattaya'); // .place second <em>
    expect(seaBreeze.stars).toBe(3);
    expect(seaBreeze.departureDate).toBe('2026-10-30');
    expect(seaBreeze.nights).toBe(12); // "15 dní / 12 nocí"
    expect(seaBreeze.pricePerPerson).toBe(36990); // "36<U+00A0>990"
  });

  it('resolves a country for every card from the card own URL slug', () => {
    // The old adapter inherited the listing slug, so a page like this one (no country of its own)
    // could not have produced a country at all.
    expect(offers.every((o) => o.country !== null)).toBe(true);
    expect(new Set(offers.map((o) => o.country)).size).toBeGreaterThanOrEqual(10);
    expect(offers.map((o) => o.country)).toContain('USA'); // not in normalize.ts's country set
    expect(offers.map((o) => o.country)).toContain('Čína');
  });

  it('holds shared invariants for every offer', () => {
    for (const o of offers) {
      expect(o.source).toBe('esotravel');
      expect(o.transport).toBe('flight'); // ESO sells air-inclusive packages only
      expect(o.departureAirport).toBe('PRG');
      expect(o.pricePerPerson).toBeGreaterThan(1000);
      expect(Number.isInteger(o.pricePerPerson)).toBe(true);
      expect(o.claimedOriginalPrice).toBeNull();
      expect(o.claimedDiscountPct).toBeNull();
      expect(o.omnibusLowestPrice).toBeNull();
      expect(o.url.startsWith(`${BASE}/`)).toBe(true);
      expect(o.title.length).toBeGreaterThan(0);
      expect((o.stars ?? 0) <= 5).toBe(true);
    }
    expect(new Set(offers.map((o) => o.sourceOfferKey)).size).toBe(offers.length);
  });
});

describe('parseEsoListing: dovolena-maledivy fixture (season-priced stays)', () => {
  const offers = parseEsoListing(maledivyFixture, 'https://www.esotravel.cz');

  it('parses all 15 pobytové cards', () => {
    expect(offers.length).toBe(15);
  });

  it('emits NO departureDate for a price-validity window', () => {
    // Every card here shows "01. 05. - 31. 10. 2026" for a "10 dní / 7 nocí" stay — the offer page
    // labels that row "V období …", i.e. the season the price is valid in, not a term. The old
    // adapter emitted its start (2026-05-01), which was already 3 months in the past on the scan
    // date and made up 24 % of the source's rows.
    expect(offers.every((o) => o.departureDate === null)).toBe(true);
    expect(offers.every((o) => o.nights === 7)).toBe(true);
  });

  it('caps stars at 5 even when ESO renders six glyphs', () => {
    const halaveli = offers.find((o) => o.url.includes('constance-halaveli'))!;
    expect(halaveli.pricePerPerson).toBe(121990);
    expect(halaveli.board).toBe('none'); // .popis "bez stravy"
    expect(halaveli.stars).toBe(5); // six fa-star glyphs in the markup
  });

  it('takes country + locality from the card itself', () => {
    const first = offers[0]!;
    expect(first.title).toBe('Reethi Faru Resort');
    expect(first.country).toBe('Maledivy');
    expect(first.locality).toBe('Raa Atol');
    expect(first.board).toBe('BB'); // .popis "snídaně"
    expect(first.pricePerPerson).toBe(54990);
    expect(first.url).toBe(`${BASE}/pobytove/maledivy/hotel/reethi-faru-resort-raa-atol/?ha=4439&zj=470`);
  });

  it('extracts the full board mix from the pobytové .popis (secondary layout)', () => {
    const boards = new Set(offers.map((o) => o.board));
    expect(boards.has('BB')).toBe(true);
    expect(boards.has('FB')).toBe(true);
    expect(boards.has('AI')).toBe(true);
    expect(boards.has('HB')).toBe(true);
  });
});

describe('parseEsoListing: dovolena-thajsko fixture (mixed poznávací + pobytové)', () => {
  const offers = parseEsoListing(thajskoFixture, BASE);

  it('parses 22 cards, skipping the one price-less/empty-termin card', () => {
    expect(offers.length).toBe(22);
  });

  it('keeps a GENUINE term (incl. the Dec→Jan year wrap) rather than nulling it', () => {
    // "22. 12. - 03. 01. 2027" for "13 dní / 10 nocí": the year is printed once, at the END, and
    // the range is as long as the trip — a real departure, not a price window.
    const xmas = offers.find((o) => o.url.includes('termin=2264658'))!;
    expect(xmas.title).toContain('SKRYTÁ TVÁŘ THAJSKA');
    expect(xmas.departureDate).toBe('2026-12-22');
    expect(xmas.nights).toBe(10);
    expect(xmas.pricePerPerson).toBe(83690);
  });

  it('gives a cross-listed card the country of its OWN url, not of the listing', () => {
    // Both cards sit on the Thailand listing; the old adapter tagged them Thajsko.
    const angkor = offers.find((o) => o.url.includes('/poznavaci/kambodza/'))!;
    expect(angkor.country).toBe('Kambodža');
    const mekong = offers.find((o) => o.url.includes('/poznavaci/laos/'))!;
    expect(mekong.country).toBe('Laos');
  });

  it('counts a half star instead of rounding it down', () => {
    const jomtien = offers.find((o) => o.url.includes('grand-jomtien-palace'))!;
    expect(jomtien.stars).toBe(3.5); // 3x fa-star + 1x fa-star-half
  });

  it('exercises both key strategies on one page (poznávací ?termin= and pobytové ?ha=)', () => {
    expect(offers.some((o) => o.url.includes('?termin='))).toBe(true);
    expect(offers.some((o) => o.url.includes('/pobytove/') && o.url.includes('ha='))).toBe(true);
  });
});

describe('parseEsoListing: last-minute fixtures', () => {
  it('resolves countries normalize.ts does not know (USA, Čína) from the url slug', () => {
    const offers = parseEsoListing(lastMinuteFixture, BASE);
    expect(offers.length).toBe(15);
    const first = offers[0]!;
    expect(first.title).toBe('Americký západ - zlatý okruh');
    expect(first.country).toBe('USA'); // was null before: "USA" is not in COUNTRY_BY_KEY
    expect(first.locality).toBeNull(); // the .tour-type span is a country slot here
    expect(first.departureDate).toBe('2026-08-10');
    expect(first.nights).toBe(14);
    expect(first.pricePerPerson).toBe(88990);
    expect(first.url).toBe(`${BASE}/poznavaci/usa/americky-zapad-zlaty-okruh/?termin=2249820`);
    expect(offers.every((o) => o.country !== null)).toBe(true);
    expect(offers.every((o) => o.claimedDiscountPct === null)).toBe(true);
  });

  it('parses the deep page that carries the site own feed_end marker', () => {
    expect(lastMinuteP1Fixture).toContain('<!-- feed_end -->');
    const offers = parseEsoListing(lastMinuteP1Fixture, BASE);
    expect(offers.length).toBe(9);
    expect(offers.map((o) => o.country)).toContain('Jihoafrická republika'); // slug jizni-afrika
  });
});

describe('parseEsoListing: edge cases (synthetic cards)', () => {
  it('returns an empty array when the page has no cards', () => {
    expect(parseEsoListing('<html><body>nothing</body></html>', BASE)).toEqual([]);
  });

  it('skips a card whose price is absent ("na vyžádání" / vyprodáno)', () => {
    const html = page([
      card({ name: 'Priced', href: '/poznavaci/kuba/a/?termin=1', price: `40${NBSP}000` }),
      card({ name: 'On request', href: '/poznavaci/kuba/b/?termin=2', price: null }),
    ]);
    expect(parseEsoListing(html, BASE).map((o) => o.title)).toEqual(['Priced']);
  });

  it('nulls the date when the range is far longer than the trip it prices', () => {
    const window = parseEsoListing(
      page([card({ href: '/pobytove/maledivy/hotel/x/?ha=5&zj=470', date: '01. 05. - 31. 10. 2026', days: '10 dní / 7 nocí' })]),
      BASE,
    );
    expect(window[0]!.departureDate).toBeNull();

    // A range that matches the trip length is a real term and must survive.
    const term = parseEsoListing(
      page([card({ href: '/pobytove/maledivy/hotel/x/?ha=5&zj=470', date: '01. 05. - 10. 05. 2026', days: '10 dní / 7 nocí' })]),
      BASE,
    );
    expect(term[0]!.departureDate).toBe('2026-05-01');
  });

  it('keeps the date when the trip length is unknown (only nulls what it can disprove)', () => {
    const offers = parseEsoListing(
      page([card({ href: '/poznavaci/kuba/x/?termin=3', date: '01. 05. - 31. 10. 2026', days: 'termín na dotaz' })]),
      BASE,
    );
    expect(offers[0]!.departureDate).toBe('2026-05-01');
    expect(offers[0]!.nights).toBeNull();
  });

  it('caps stars at 5 and counts half stars', () => {
    const six = parseEsoListing(page([card({ href: '/pobytove/maledivy/hotel/y/?ha=6&zj=470', stars: 6 })]), BASE);
    expect(six[0]!.stars).toBe(5);
    const half = parseEsoListing(page([card({ href: '/pobytove/thajsko/hotel/y/?ha=7&zj=26', stars: 3, halfStar: true })]), BASE);
    expect(half[0]!.stars).toBe(3.5);
    const none = parseEsoListing(page([card({ href: '/poznavaci/kuba/y/?termin=8' })]), BASE);
    expect(none[0]!.stars).toBeNull();
  });

  it('falls back to .place / .tour-type when the url has no country slug, else null', () => {
    const promo = parseEsoListing(
      page([card({ href: '/africka-odysea/', span: 'Afrika', place: ['Mauricius', 'Afrika'] })]),
      BASE,
    );
    expect(promo[0]!.country).toBe('Mauricius'); // .place first <em>
    expect(promo[0]!.locality).toBe('Afrika');

    const unknown = parseEsoListing(page([card({ href: '/indicky-ocean-2025/', span: 'Cesty kolem světa' })]), BASE);
    expect(unknown[0]!.country).toBeNull(); // never guess a country
    expect(unknown[0]!.locality).toBe('Cesty kolem světa');
  });

  it('produces a price-independent sourceOfferKey (stable across price drops)', () => {
    // ESO price-drop detection relies entirely on our own snapshots keyed by sourceOfferKey,
    // so a price change MUST NOT change the key.
    const cheap = parseEsoListing(page([card({ href: '/poznavaci/kuba/z/?termin=555', price: `60${NBSP}000` })]), BASE);
    const dropped = parseEsoListing(page([card({ href: '/poznavaci/kuba/z/?termin=555', price: `49${NBSP}000` })]), BASE);
    expect(cheap[0]!.pricePerPerson).toBe(60000);
    expect(dropped[0]!.pricePerPerson).toBe(49000);
    expect(dropped[0]!.sourceOfferKey).toBe(cheap[0]!.sourceOfferKey);
  });

  it('keys pobytové cards (no ?termin=) stably by url path + ha + date + nights', () => {
    const a = parseEsoListing(
      page([card({ href: '/pobytove/maledivy/hotel/h/?ha=42&zj=470', variant: 'pobyt-box', price: `70${NBSP}000` })]),
      BASE,
    );
    const b = parseEsoListing(
      page([card({ href: '/pobytove/maledivy/hotel/h/?ha=42&zj=470', variant: 'pobyt-box', price: `55${NBSP}000` })]),
      BASE,
    );
    expect(a[0]!.sourceOfferKey).toBe(b[0]!.sourceOfferKey);
    expect(a[0]!.sourceOfferKey.length).toBeGreaterThan(0);
  });
});

describe('esotravel.fetchOffers: paginated walk within the request budget', () => {
  /** http mock that serves `pagesPerFeed` distinct pages per feed, then empty ones. */
  function pagedHttp(pagesPerFeed: number, opts: { feedEnd?: number } = {}) {
    const seen: string[] = [];
    const text = vi.fn(async (url: string) => {
      seen.push(url);
      const page$ = Number(new URL(url).searchParams.get('strana') ?? '0');
      const feed = new URL(url).pathname;
      if (page$ >= pagesPerFeed) return page([]);
      return page(
        [card({ name: `${feed}#${page$}`, href: `/poznavaci/kuba/t/?termin=${feed.length}-${page$}` })],
        { feedEnd: opts.feedEnd === page$ },
      );
    });
    return { seen, http: { text, json: vi.fn() } as unknown as SourceContext['http'] };
  }

  it('walks ?strana=N per feed and stops the feed once a page adds nothing new', async () => {
    const { seen, http } = pagedHttp(3);
    const offers = await esotravel.fetchOffers(makeCtx(http));
    // 3 feeds x (3 real pages + 1 empty page that stops the walk) = 12 requests
    expect(seen.length).toBe(12);
    expect(offers.length).toBe(9);
    expect(seen.slice(0, 4)).toEqual([
      'https://www.esotravel.cz/dovolena/zajezdy/',
      'https://www.esotravel.cz/dovolena/zajezdy/?strana=1',
      'https://www.esotravel.cz/dovolena/zajezdy/?strana=2',
      'https://www.esotravel.cz/dovolena/zajezdy/?strana=3',
    ]);
    expect(seen).toContain('https://www.esotravel.cz/last-minute/?strana=1');
    expect(seen).toContain('https://www.esotravel.cz/first-moment/?strana=1');
  });

  it('stops a feed on the site own <!-- feed_end --> marker', async () => {
    const { seen, http } = pagedHttp(9, { feedEnd: 1 });
    await esotravel.fetchOffers(makeCtx(http));
    // Every feed ends after page 1 even though page 2+ would still serve cards.
    expect(seen.filter((u) => u.includes('/dovolena/zajezdy/')).length).toBe(2);
    expect(seen.every((u) => !u.includes('strana=2'))).toBe(true);
  });

  it('never exceeds the request budget even if the feeds never run out', async () => {
    // A site change (endless priced pages) must not blow the 240 s adapter timeout: the per-feed
    // page caps (16 + 4 + 4) and MAX_REQUESTS = 30 bound the walk.
    const { seen, http } = pagedHttp(Number.POSITIVE_INFINITY);
    const offers = await esotravel.fetchOffers(makeCtx(http));
    expect(seen.length).toBeLessThanOrEqual(30);
    expect(seen.length).toBe(24);
    expect(seen.filter((u) => u.includes('/dovolena/zajezdy/')).length).toBe(16);
    expect(seen).toContain('https://www.esotravel.cz/dovolena/zajezdy/?strana=15');
    expect(offers.length).toBe(24);
  });

  it('dedupes globally across feeds by sourceOfferKey', async () => {
    // The same term surfaces in the catalogue AND in last-minute -> one offer.
    const http = {
      text: vi.fn(async () => page([card({ name: 'Shared Tour', href: '/poznavaci/kuba/s/?termin=42' })])),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    const offers = await esotravel.fetchOffers(makeCtx(http));
    expect(offers.length).toBe(1);
    // Each feed needs a SECOND page to notice it is repeating itself (novelty is judged within the
    // feed, see below), so 2 + 2 + 2 requests — never the full cap.
    expect((http.text as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);
  });

  it('keeps walking a curated feed whose page 0 the catalogue already covered', async () => {
    // Regression guard. Live 2026-07-29, /last-minute/ page 0 held 15 priced cards of which only
    // ONE was absent from the catalogue — judging the stop on GLOBAL novelty would abandon that
    // feed at page 0 after any reshuffle covering that last card, silently losing page 1. Here
    // page 0 of both curated feeds is a byte-for-byte subset of the catalogue and page 1 carries
    // the offer that exists nowhere else: it MUST still be fetched.
    const shared = card({ name: 'Shared', href: '/poznavaci/kuba/s/?termin=42' });
    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('strana=1') && !url.includes('/dovolena/zajezdy/')) {
          return page([card({ name: 'Deal Only', href: `/poznavaci/peru/d/?termin=${new URL(url).pathname.length}` })]);
        }
        return page([shared]);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const offers = await esotravel.fetchOffers(makeCtx(http));
    expect(offers.map((o) => o.title).sort()).toEqual(['Deal Only', 'Deal Only', 'Shared']);
    const urls = (http.text as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(urls).toContain('https://www.esotravel.cz/last-minute/?strana=1');
    expect(urls).toContain('https://www.esotravel.cz/first-moment/?strana=1');
  });

  it('still stops a feed when ?strana= is ignored and page 0 is re-served verbatim', async () => {
    // The case the stop rule exists for: if the site stops honouring `strana`, every page is a
    // verbatim repeat of page 0 — endlessly parsable, so only per-feed novelty can end the walk.
    // It must NOT run to the 16+4+4 page caps.
    const text = vi.fn(async (url: string) =>
      page([card({ name: 'Always Page Zero', href: `/poznavaci/kuba/z/?termin=${new URL(url).pathname.length}` })]),
    );
    const http = { text, json: vi.fn() } as unknown as SourceContext['http'];
    const offers = await esotravel.fetchOffers(makeCtx(http));
    expect(text.mock.calls.length).toBe(6); // 2 per feed, not 24
    expect(offers.length).toBe(3); // one distinct card per feed
  });
});

describe('esotravel.fetchOffers: error handling contract', () => {
  it('skips a single failing page and keeps walking the rest of that feed', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('/dovolena/zajezdy/?strana=1')) throw new Error('network hiccup');
        if (url.includes('/dovolena/zajezdy/?strana=2')) {
          return page([card({ name: 'Deep Tour', href: '/poznavaci/peru/d/?termin=9' })]);
        }
        if (url === 'https://www.esotravel.cz/dovolena/zajezdy/') {
          return page([card({ name: 'First Tour', href: '/poznavaci/kuba/f/?termin=1' })]);
        }
        return page([]);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await esotravel.fetchOffers(ctx);
    expect(offers.map((o) => o.title).sort()).toEqual(['Deep Tour', 'First Tour']);
    expect(ctx.log as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.stringContaining('strana=1 failed'));
  });

  it('abandons a feed after two consecutive failures but still walks the next feed', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('/dovolena/zajezdy/')) throw new Error('feed down');
        if (url === 'https://www.esotravel.cz/last-minute/') {
          return page([card({ name: 'LM Tour', href: '/poznavaci/egypt/l/?termin=3' })]);
        }
        return page([]);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const offers = await esotravel.fetchOffers(makeCtx(http));
    expect(offers.map((o) => o.title)).toEqual(['LM Tour']);
    const urls = (http.text as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(urls.filter((u) => u.includes('/dovolena/zajezdy/')).length).toBe(2);
  });

  it('stops on SourceBlockedError but keeps offers collected so far', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        if (url === 'https://www.esotravel.cz/dovolena/zajezdy/') {
          return page([card({ name: 'Katalog Tour', href: '/poznavaci/kuba/k/?termin=1' })]);
        }
        throw new SourceBlockedError(403, 'blocked');
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const offers = await esotravel.fetchOffers(makeCtx(http));
    expect(offers.map((o) => o.title)).toEqual(['Katalog Tour']);
    // page 0 (ok) + page 1 (blocked) = 2 fetches, then stop everything.
    expect((http.text as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('rethrows when the FIRST request is blocked before any success (backoff must engage)', async () => {
    const http = {
      text: vi.fn(async () => {
        throw new SourceBlockedError(403, 'blocked');
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    await expect(esotravel.fetchOffers(makeCtx(http))).rejects.toThrow('blocked');
    expect((http.text as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('rethrows the last error when every request fails', async () => {
    const http = {
      text: vi.fn(async () => {
        throw new Error('total outage');
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    // Must not degrade to [] — runScan has to record this source 'failed'.
    await expect(esotravel.fetchOffers(makeCtx(http))).rejects.toThrow('total outage');
  });
});
