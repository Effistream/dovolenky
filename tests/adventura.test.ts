import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  filterExoticTourUrls,
  parseAdventuraDetail,
  selectDetailWindow,
  adventura,
  MAX_DETAILS,
  MAX_REQUESTS_PER_RUN,
  ROTATION_PERIOD_MS,
  EXOTIC_SLUG_TOKENS,
} from '../src/sources/adventura.js';
import { offerKeyHash } from '../src/core/normalize.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sitemapExcerpt = readFileSync(join(__dirname, 'fixtures/adventura/sitemap-excerpt.xml'), 'utf-8');
const nepalFixture = readFileSync(join(__dirname, 'fixtures/adventura/detail-nepal-everest.html'), 'utf-8');
const reunionFixture = readFileSync(join(__dirname, 'fixtures/adventura/detail-reunion-mauricius.html'), 'utf-8');
const havajFixture = readFileSync(join(__dirname, 'fixtures/adventura/detail-havaj-no-meals.html'), 'utf-8');

const BASE = 'https://www.adventura.cz';

// The 14 exotic detail URLs in the excerpt, in the lexicographic order filterExoticTourUrls emits.
const EXCERPT_EXOTIC = [
  `${BASE}/zajezdy/10084-jihoafricka-republika-na-kole/`,
  `${BASE}/zajezdy/11268-treking-na-kapverdach/`,
  `${BASE}/zajezdy/11836-nepal-treking-udolim-serpu-az-k-everestu/`,
  `${BASE}/zajezdy/11848-treking-na-reunionu/`,
  `${BASE}/zajezdy/11888-dominikanska-republika-turistika-a-koupani/`,
  `${BASE}/zajezdy/11967-sri-lanka-na-kole/`,
  `${BASE}/zajezdy/11974-kambodza-na-kole/`,
  `${BASE}/zajezdy/12088-tibetem-do-nepalu/`,
  `${BASE}/zajezdy/12112-toulky-po-maledivach/`,
  `${BASE}/zajezdy/12469-jar-kapske-mesto-vino-a-narodni-parky/`,
  `${BASE}/zajezdy/12666-reunion-a-mauricius-turistika-a-koupani/`,
  `${BASE}/zajezdy/12704-indonesky-lombok-na-kole/`,
  `${BASE}/zajezdy/12891-silvestr-v-jizni-africe-vinice-a-np-kruger/`,
  `${BASE}/zajezdy/12931-kuba-autenticka/`,
];

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCtx(http: SourceContext['http']): SourceContext {
  return { http, adults: 2, log: vi.fn() };
}

/** Pins Date.now() so the rotating window under test is deterministic. */
function atWindow(index: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(index * ROTATION_PERIOD_MS);
}

/** Synthetic sitemap with `count` exotic tour URLs (ids are zero-padded so the sort is stable). */
function syntheticSitemap(count: number): string {
  const locs = Array.from(
    { length: count },
    (_, i) => `<url><loc>${BASE}/zajezdy/${10000 + i}-nepal-tour-${String(i).padStart(3, '0')}/</loc></url>`,
  ).join('');
  return `<?xml version="1.0"?><urlset>${locs}</urlset>`;
}

// --- Synthetic detail-page builder mirroring the real table.date-list + graybox.terms markup.
// Each term is one <tbody class="date"> with a <tr class="heading"> (the offer-bearing row) plus a
// collapsable duplicate sub-row (to prove sub-rows are NOT double-counted).
interface TermOpts {
  term?: string; // span.term range, e.g. "29. 10. – 18. 11. 2026"
  length?: string; // td.length, e.g. "21 dní"
  price?: string | null; // strong text with NBSP thousands, e.g. "74 052"; null => empty price cell
  discountPct?: number | null; // span.discount-percentage integer, e.g. 1
  original?: string | null; // small.line-through.original-price, e.g. "74 800"
  code?: string; // td.code order number
}

const NBSP = ' ';

function termRow(o: TermOpts = {}): string {
  const term = o.term ?? '29. 10. – 18. 11. 2026';
  const length = o.length ?? '21 dní';
  const code = o.code ?? '25243601';
  const disc = o.discountPct != null ? `<span class="discount-percentage">-${o.discountPct}%</span>` : '';
  const orig =
    o.original != null ? `<small class="line-through original-price">${o.original}${NBSP}Kč</small>` : '';
  const priceCell =
    o.price === null
      ? `<td class="value print-hide"></td>`
      : `<td class="value print-hide"><span class="price-value">${disc}<strong>${o.price ?? `74${NBSP}052`}${NBSP}Kč</strong></span>${orig}</td>`;
  return `<tbody class="date">
    <tr class="heading">
      <td class="desktop collapse-toggle print-hide"><span class="btn"></span></td>
      <td class="range"><span class="term">${term}</span></td>
      <td class="length">${length}</td>
      ${priceCell}
      <td class="value additional-value print-hide "></td>
      <td class="code">${code}</td>
      <td class="reservation-link"><a href="#">Rezervovat</a></td>
    </tr>
    <tr class="print-hide price collapsable discounted">
      <td class="title" colspan="2">Základní cena</td>
      <td class="value"><span class="price-value"><strong>${o.price ?? `74${NBSP}052`}${NBSP}Kč</strong></span></td>
      <td class="original-value"><span class="line-through original-price">${o.original ?? ''}</span></td>
    </tr>
  </tbody>`;
}

interface PageOpts {
  title?: string;
  sub?: string | null;
  terms?: string[];
  included?: string; // "V ceně zahrnuto" prose (transport/board source)
  excluded?: string; // "V ceně nezahrnuto" prose (drives board 'none')
}

function detailPage(o: PageOpts = {}): string {
  const title = o.title ?? 'Nepál – treking údolím Šerpů až k Everestu';
  const terms = o.terms ?? [termRow()];
  const included = o.included ?? 'průvodce CK, letenka Praha–Káthmándú–Praha, transfery';
  const excluded = o.excluded ?? 'vízum, fakultativní snídaně lze zakoupit';
  return `<html><body>
    <h1>Váš prohlížeč není podporován :(</h1>
    <h1 class="print-show top upper">${title}</h1>
    <h1 class="top upper">${title}</h1>
    ${o.sub ? `<p class="sub">${o.sub}</p>` : ''}
    <table class="date-list">
      <thead><tr><td class="range">Termín</td><td class="length">Počet dní</td><td class="value">Aktuální cena</td><td class="code">Obj. číslo</td></tr></thead>
      ${terms.join('')}
    </table>
    <div class="graybox terms"><h2>Podmínky</h2>
      <div class="row"><div class="column fourth"><strong class="orange">V ceně zahrnuto:</strong></div><div class="column three-fourths"><p>${included}</p></div></div>
      <div class="row"><div class="column fourth"><strong class="orange">V ceně nezahrnuto:</strong></div><div class="column three-fourths"><p>${excluded}</p></div></div>
    </div>
  </body></html>`;
}

describe('request-budget constants', () => {
  it('caps the whole run at MAX_REQUESTS_PER_RUN = 40 (1 sitemap + 39 details)', () => {
    // run.ts aborts an adapter at ADAPTER_FETCH_TIMEOUT_MS = 240 s and the host gap is 3 s, so
    // 40 requests (~140 s measured) is the ceiling. Raising it needs a fresh wall-clock measurement.
    expect(MAX_REQUESTS_PER_RUN).toBe(40);
    expect(MAX_DETAILS).toBe(MAX_REQUESTS_PER_RUN - 1);
  });

  it('rotates on the 2 h scan cadence', () => {
    expect(ROTATION_PERIOD_MS).toBe(2 * 60 * 60 * 1000);
  });

  it('exposes exotic stems, not full nominatives (Czech declension changes endings)', () => {
    for (const t of ['nepal', 'vietnam', 'sri-lanka', 'zanzibar', 'reunion', 'mauric', 'jar', 'galapag']) {
      expect(EXOTIC_SLUG_TOKENS).toContain(t);
    }
    // Regression guard for audit finding 4: these four used to be full nominatives and matched
    // nothing in the declined slugs the site actually publishes.
    for (const t of ['malediv', 'kapverd', 'indone', 'jihoafric']) {
      expect(EXOTIC_SLUG_TOKENS).toContain(t);
    }
    // Multi-word stem: Adventura's third spelling of the same watched country (review 2026-07-29).
    expect(EXOTIC_SLUG_TOKENS).toContain('jizni-afric');
  });
});

describe('filterExoticTourUrls: sitemap excerpt (real URL shapes)', () => {
  const urls = filterExoticTourUrls(sitemapExcerpt);

  it('selects exactly the 14 exotic /zajezdy/{id}-{slug}/ detail URLs', () => {
    expect(urls).toEqual(EXCERPT_EXOTIC);
  });

  it('selects ALL THREE spellings of Jihoafrická republika (the watched exotika country)', () => {
    // Live 2026-07-29 Adventura publishes JAR tours under three unrelated slug spellings. Missing
    // any one of them silently drops a watched-country tour from the crawl entirely — the
    // `jizni-afric` case was still unreachable after the declension fix and is worth 1 real term
    // (96 806 Kč, -3 %, departure 2026-12-29).
    expect(urls).toContain(`${BASE}/zajezdy/10084-jihoafricka-republika-na-kole/`); // jihoafric
    expect(urls).toContain(`${BASE}/zajezdy/12469-jar-kapske-mesto-vino-a-narodni-parky/`); // jar
    expect(urls).toContain(`${BASE}/zajezdy/12891-silvestr-v-jizni-africe-vinice-a-np-kruger/`); // jizni-afric
  });

  it('matches Czech-declined slugs the old full-nominative tokens missed', () => {
    // /zajezdy/12112-toulky-po-maledivach/ etc. — all live tours in watched exotika countries.
    expect(urls).toContain(`${BASE}/zajezdy/12112-toulky-po-maledivach/`); // maledivach vs 'maledivy'
    expect(urls).toContain(`${BASE}/zajezdy/11268-treking-na-kapverdach/`); // kapverdach vs 'kapverdy'
    expect(urls).toContain(`${BASE}/zajezdy/12704-indonesky-lombok-na-kole/`); // indonesky vs 'indonesie'
    expect(urls).toContain(`${BASE}/zajezdy/10084-jihoafricka-republika-na-kole/`); // vs the 'jar' acronym
    expect(urls).toContain(`${BASE}/zajezdy/11848-treking-na-reunionu/`); // reunionu
  });

  it('is deterministically (lexicographically) sorted', () => {
    expect([...urls].sort()).toEqual(urls);
  });

  it('excludes the "jarni-andalusie" false positive (jar substring in "jarní" = spring)', () => {
    expect(urls.some((u) => u.includes('jarni-andalusie'))).toBe(false);
  });

  it('excludes mid-word stem hits ("vikendovy" contains "ken")', () => {
    expect(urls.some((u) => u.includes('vikendovy-rafting'))).toBe(false);
  });

  it('never returns ?druh= / ?kontinenty= filter URLs', () => {
    expect(urls.some((u) => u.includes('?'))).toBe(false);
  });

  it('excludes detail sub-pages (/galerie/, /dalsi-fotky/) and dle-tematu category pages', () => {
    expect(urls.some((u) => u.includes('/galerie/'))).toBe(false);
    expect(urls.some((u) => u.includes('/dalsi-fotky/'))).toBe(false);
    expect(urls.some((u) => u.includes('/dle-tematu/'))).toBe(false);
  });

  it('excludes non-/zajezdy/ sections (/zeme/, /cestopisy/) even when they contain tokens', () => {
    expect(urls.some((u) => u.includes('/zeme/'))).toBe(false);
    expect(urls.some((u) => u.includes('/cestopisy/'))).toBe(false);
  });

  it('deduplicates a URL that matches multiple tokens (reunion + mauricius) to one entry', () => {
    const reunion = urls.filter((u) => u.includes('12666-reunion-a-mauricius'));
    expect(reunion.length).toBe(1);
  });

  it('returns an empty array for empty / non-matching input', () => {
    expect(filterExoticTourUrls('')).toEqual([]);
    expect(filterExoticTourUrls('<urlset></urlset>')).toEqual([]);
  });
});

describe('selectDetailWindow: rotating, budget-capped slice', () => {
  const urls = Array.from({ length: 72 }, (_, i) => `u${String(i).padStart(2, '0')}`);

  it('never exceeds MAX_DETAILS, whatever the catalogue size', () => {
    for (const n of [0, 1, 39, 40, 72, 500]) {
      const list = urls.slice(0, n).concat(Array.from({ length: Math.max(0, n - 72) }, (_, i) => `x${i}`));
      const w = selectDetailWindow(list, 0);
      expect(w.targets.length).toBeLessThanOrEqual(MAX_DETAILS);
    }
  });

  it('returns everything in a single window when the catalogue fits the budget', () => {
    const small = urls.slice(0, MAX_DETAILS);
    const w = selectDetailWindow(small, 12345);
    expect(w).toEqual({ targets: small, windowIndex: 0, windowCount: 1 });
  });

  it('covers the WHOLE list across consecutive runs and never repeats inside one cycle', () => {
    // The core regression: the old `slice(0, 25)` fetched the same 25 lowest ids forever, so 39 of
    // 64 tours could never enter the DB. Consecutive windows must partition the list exactly.
    const w0 = selectDetailWindow(urls, 0);
    const w1 = selectDetailWindow(urls, ROTATION_PERIOD_MS);
    expect(w0.windowCount).toBe(2);
    expect(w0.windowIndex).toBe(0);
    expect(w1.windowIndex).toBe(1);
    expect([...w0.targets, ...w1.targets]).toEqual(urls);
    expect(new Set([...w0.targets, ...w1.targets]).size).toBe(urls.length);
  });

  it('wraps around after a full cycle (run 3 repeats window 1)', () => {
    const w0 = selectDetailWindow(urls, 0);
    const w2 = selectDetailWindow(urls, 2 * ROTATION_PERIOD_MS);
    expect(w2.targets).toEqual(w0.targets);
  });

  it('keeps the same window for two timestamps inside one rotation period (cron jitter)', () => {
    const a = selectDetailWindow(urls, 5 * ROTATION_PERIOD_MS);
    const b = selectDetailWindow(urls, 5 * ROTATION_PERIOD_MS + 20 * 60 * 1000);
    expect(b.targets).toEqual(a.targets);
  });

  it('handles an empty list without dividing by zero', () => {
    expect(selectDetailWindow([], 0)).toEqual({ targets: [], windowIndex: 0, windowCount: 1 });
  });
});

describe('parseAdventuraDetail: nepal-everest fixture (real; discount row, board unknown)', () => {
  const url = `${BASE}/zajezdy/11836-nepal-treking-udolim-serpu-az-k-everestu/`;
  const offers = parseAdventuraDetail(nepalFixture, url);

  it('yields exactly one offer (single departure term; collapsable sub-rows not double-counted)', () => {
    expect(offers.length).toBe(1);
  });

  it('maps the term row to the expected NormalizedOffer', () => {
    const o = offers[0]!;
    expect(o.source).toBe('adventura');
    expect(o.title).toBe('Nepál – treking údolím Šerpů až k Everestu');
    expect(o.country).toBe('Nepál');
    expect(o.departureDate).toBe('2026-10-29'); // first date of "29. 10. – 18. 11. 2026"
    expect(o.nights).toBe(20); // "21 dní" -> 21 - 1
    expect(o.pricePerPerson).toBe(74052); // "74 052 Kč" (U+00A0 separator)
    expect(o.claimedOriginalPrice).toBe(74800); // small.line-through.original-price
    expect(o.claimedDiscountPct).toBe(1); // "-1%"
    expect(o.transport).toBe('flight'); // "letenka" in V ceně zahrnuto
    // "snídaně zakoupit" sits in V ceně NEzahrnuto -> no false BB. And because that block names
    // breakfast rather than "stravování", we must NOT jump to 'none' either.
    expect(o.board).toBe('unknown');
    expect(o.sourceOfferKey).toBe(offerKeyHash(['25243601']));
    expect(o.url).toBe(url);
    expect(o.priceTotal).toBeNull();
    expect(o.omnibusLowestPrice).toBeNull();
    expect(o.stars).toBeNull();
    expect(o.departureAirport).toBeNull();
  });
});

describe('parseAdventuraDetail: reunion-mauricius fixture (real; multi-country title, board BB)', () => {
  const url = `${BASE}/zajezdy/12666-reunion-a-mauricius-turistika-a-koupani/`;
  const offers = parseAdventuraDetail(reunionFixture, url);

  it('yields one offer', () => {
    expect(offers.length).toBe(1);
  });

  it('picks the first KNOWN country from a multi-country title ("Réunion a Mauricius" -> Réunion)', () => {
    expect(offers[0]!.country).toBe('Réunion');
  });

  it('maps the term row (matches the spec example exactly)', () => {
    const o = offers[0]!;
    expect(o.title).toBe('Réunion a Mauricius – turistika a koupání');
    expect(o.departureDate).toBe('2026-11-11'); // "11. 11. – 23. 11. 2026"
    expect(o.nights).toBe(12); // "13 dní"
    expect(o.pricePerPerson).toBe(78204);
    expect(o.claimedOriginalPrice).toBe(79800);
    expect(o.claimedDiscountPct).toBe(2); // "-2%"
    expect(o.transport).toBe('flight');
    expect(o.board).toBe('BB'); // "se snídaní" in V ceně zahrnuto
    expect(o.sourceOfferKey).toBe(offerKeyHash(['26591601']));
  });
});

describe('parseAdventuraDetail: havaj fixture (real; meals explicitly NOT included -> board none)', () => {
  // Live page saved 2026-07-29. "V ceně zahrnuto" lists only "12x ubytování v apartmánech či
  // hotelech"; "V ceně nezahrnuto" opens with "Stravování". Audit finding 6: this used to report
  // board 'unknown', which also opted the offer out of computeMatchKey (it nulls on 'unknown').
  const url = `${BASE}/zajezdy/11893-havaj-velky-okruh-ctyrmi-ostrovy/`;
  const offers = parseAdventuraDetail(havajFixture, url);

  it('parses all three departure terms', () => {
    expect(offers.length).toBe(3);
    expect(offers.map((o) => o.departureDate)).toEqual(['2026-10-22', '2027-04-16', '2027-10-21']);
    expect(offers.map((o) => o.pricePerPerson)).toEqual([129800, 124608, 124608]);
    expect(offers.map((o) => o.nights)).toEqual([14, 14, 14]);
  });

  it('reports board "none" rather than "unknown"', () => {
    expect(offers.every((o) => o.board === 'none')).toBe(true);
  });

  it('still resolves transport from the included prose', () => {
    expect(offers.every((o) => o.transport === 'flight')).toBe(true);
  });

  it('leaves country null (Havaj is a US state; USA is out of scope by design)', () => {
    expect(offers.every((o) => o.country === null)).toBe(true);
  });
});

describe('parseAdventuraDetail: synthetic edge cases', () => {
  const url = `${BASE}/zajezdy/9999-test/`;

  it('parses multiple departure terms into one offer per term', () => {
    const html = detailPage({
      terms: [
        termRow({ term: '10. 01. – 22. 01. 2027', length: '13 dní', code: '1001', price: `60${NBSP}000` }),
        termRow({ term: '05. 02. – 17. 02. 2027', length: '13 dní', code: '1002', price: `62${NBSP}000` }),
      ],
    });
    const offers = parseAdventuraDetail(html, url);
    expect(offers.length).toBe(2);
    expect(offers.map((o) => o.departureDate)).toEqual(['2027-01-10', '2027-02-05']);
    expect(offers.map((o) => o.sourceOfferKey)).toEqual([offerKeyHash(['1001']), offerKeyHash(['1002'])]);
    expect(new Set(offers.map((o) => o.sourceOfferKey)).size).toBe(2);
  });

  it('skips a term row with no parsable price', () => {
    const html = detailPage({
      terms: [
        termRow({ code: '1', price: null }),
        termRow({ code: '2', price: `50${NBSP}000`, term: '01. 03. – 10. 03. 2027', length: '10 dní' }),
      ],
    });
    const offers = parseAdventuraDetail(html, url);
    expect(offers.map((o) => o.sourceOfferKey)).toEqual([offerKeyHash(['2'])]);
  });

  it('sets claimedOriginalPrice only when the crossed-out price exceeds the current price', () => {
    const higher = parseAdventuraDetail(
      detailPage({ terms: [termRow({ price: `70${NBSP}000`, original: `80${NBSP}000`, discountPct: 12, code: 'a' })] }),
      url,
    );
    expect(higher[0]!.claimedOriginalPrice).toBe(80000);
    expect(higher[0]!.claimedDiscountPct).toBe(12);

    // No line-through at all -> null original, null pct.
    const none = parseAdventuraDetail(
      detailPage({ terms: [termRow({ price: `70${NBSP}000`, original: null, discountPct: null, code: 'b' })] }),
      url,
    );
    expect(none[0]!.claimedOriginalPrice).toBeNull();
    expect(none[0]!.claimedDiscountPct).toBeNull();

    // Degenerate crossed-out price <= current -> treated as no real discount (null).
    const notHigher = parseAdventuraDetail(
      detailPage({ terms: [termRow({ price: `70${NBSP}000`, original: `70${NBSP}000`, code: 'c' })] }),
      url,
    );
    expect(notHigher[0]!.claimedOriginalPrice).toBeNull();
  });

  it('assigns the previous year to a Dec->Jan range printed with a single trailing year', () => {
    const html = detailPage({
      terms: [termRow({ term: '27. 12. – 05. 01. 2027', length: '10 dní', code: 'x', price: `90${NBSP}000` })],
    });
    const o = parseAdventuraDetail(html, url)[0]!;
    expect(o.departureDate).toBe('2026-12-27'); // start month 12 > end month 1 -> year-1
  });

  it('guards the discount percentage to 0 < pct < 100', () => {
    const bad = parseAdventuraDetail(
      detailPage({ terms: [termRow({ price: `70${NBSP}000`, original: `80${NBSP}000`, discountPct: 0, code: 'z' })] }),
      url,
    );
    expect(bad[0]!.claimedDiscountPct).toBeNull();
  });

  it('detects transport=bus and board from the V-ceně-zahrnuto prose', () => {
    const html = detailPage({
      title: 'Mexiko – velká poznávací cesta',
      included: 'doprava autobusem po celé trase, ubytování s polopenzí',
      terms: [termRow({ price: `55${NBSP}000`, code: 'm' })],
    });
    const o = parseAdventuraDetail(html, url)[0]!;
    expect(o.country).toBe('Mexiko');
    expect(o.transport).toBe('bus');
    expect(o.board).toBe('HB');
  });

  it('does NOT downgrade to board none when the included prose itself talks about stravování', () => {
    // "stravování dle programu" means meals ARE part of the price, just not as a named board —
    // the not-included block's own "stravování nad rámec programu" must not flip it to 'none'.
    const html = detailPage({
      included: 'letenka, ubytování, stravování dle programu',
      excluded: 'stravování nad rámec programu, vízum',
      terms: [termRow({ price: `70${NBSP}000`, code: 's' })],
    });
    expect(parseAdventuraDetail(html, url)[0]!.board).toBe('unknown');
  });

  it('returns [] when there is no date-list table', () => {
    expect(parseAdventuraDetail('<html><body><h1 class="top upper">X</h1></body></html>', url)).toEqual([]);
  });

  it('resolves the country from Czech-declined titles (audit finding 7)', () => {
    const cases: [string, string][] = [
      ['Treking na Réunionu', 'Réunion'],
      ['Silvestr v Kambodži', 'Kambodža'],
      ['Toulky po Maledivách', 'Maledivy'],
      ['Treking na Kapverdách', 'Kapverdy'],
      ['Indonéský Lombok na kole', 'Indonésie'],
      ['JAR – Kapské Město, víno a národní parky', 'Jihoafrická republika'],
      ['Kanoe v Namibii na Kunene', 'Namibie'],
      // Live title of /zajezdy/12891-…/. "Jižní Afrika" is absent from COUNTRIES, so pass 1 fails
      // and only the `jizni-afric` stem resolves it — before that it emitted country: null.
      ['Silvestr v Jižní Africe – vinice a NP Kruger', 'Jihoafrická republika'],
      // Guard for the two-word stem: "jizni-…" alone must NOT read as Jihoafrická republika.
      ['Jižní Vietnam – Vánoce a Silvestr na kole', 'Vietnam'],
    ];
    for (const [title, expected] of cases) {
      const o = parseAdventuraDetail(detailPage({ title, terms: [termRow({ code: title })] }), url)[0]!;
      expect(`${title} -> ${o.country}`).toBe(`${title} -> ${expected}`);
    }
  });

  it('still prefers the FIRST country of a multi-country title in the declension pass', () => {
    const o = parseAdventuraDetail(
      detailPage({ title: 'Národní parky Tanzanie a ostrov Zanzibar', terms: [termRow({ code: 'tz' })] }),
      url,
    )[0]!;
    expect(o.country).toBe('Tanzanie');
  });

  it('falls back to the URL slug when the title uses a synonym the dictionary lacks', () => {
    // Live: /zajezdy/12469-jar-kapske-mesto-vino-a-narodni-parky/ is titled "Jižní Afrika – …".
    // "Jižní Afrika" is not in COUNTRIES, so title and sub both yield null; the slug's `jar` does.
    const o = parseAdventuraDetail(
      detailPage({ title: 'Jižní Afrika – Kapské Město, víno a národní parky', terms: [termRow({ code: 'za' })] }),
      `${BASE}/zajezdy/12469-jar-kapske-mesto-vino-a-narodni-parky/`,
    )[0]!;
    expect(o.country).toBe('Jihoafrická republika');
  });

  it('does not let the slug fall back over a country the title already names', () => {
    const o = parseAdventuraDetail(
      detailPage({ title: 'Silvestr v Kambodži', terms: [termRow({ code: 'kh' })] }),
      `${BASE}/zajezdy/12898-silvestr-v-kambodzi/`,
    )[0]!;
    expect(o.country).toBe('Kambodža');
  });

  it('leaves country null when the only exotic marker has no canonical country', () => {
    // Kostarika / Panama / Havaj / Ekvádor are crawled (they are genuine long-haul stock) but are
    // absent from core/normalize.ts's COUNTRIES, so `country` must stay null rather than guess.
    const html = detailPage({ title: 'Kostarika a panamský průplav', terms: [termRow({ code: 'k' })] });
    expect(parseAdventuraDetail(html, url)[0]!.country).toBeNull();
  });
});

describe('adventura.fetchOffers: sitemap-bounded crawl', () => {
  it('GETs the sitemap once, then one GET per selected exotic detail URL', async () => {
    atWindow(0);
    const seen: string[] = [];
    const http = {
      text: vi.fn(async (u: string) => {
        seen.push(u);
        if (u.endsWith('/sitemap.xml')) return sitemapExcerpt;
        return detailPage({ terms: [termRow({ code: u })] });
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const offers = await adventura.fetchOffers(makeCtx(http));
    expect(seen[0]).toBe(`${BASE}/sitemap.xml`);
    // 1 sitemap + 14 exotic details (excerpt has 14, under the 39-detail budget)
    expect(seen.length).toBe(15);
    expect(offers.length).toBe(14);
  });

  it('never issues more than MAX_REQUESTS_PER_RUN requests, however big the sitemap', async () => {
    atWindow(0);
    let requests = 0;
    const http = {
      text: vi.fn(async (u: string) => {
        requests += 1;
        if (u.endsWith('/sitemap.xml')) return syntheticSitemap(500);
        return detailPage({ terms: [termRow({ code: u })] });
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    await adventura.fetchOffers(makeCtx(http));
    expect(requests).toBe(MAX_REQUESTS_PER_RUN);
  });

  it('rotates the window so consecutive runs cover the WHOLE catalogue (no permanent blind spot)', async () => {
    // Regression test for the audit's headline finding: with 72 exotic URLs and a 39-page budget,
    // run 1 + run 2 must together fetch all 72 — the old fixed prefix fetched the same 25 forever.
    const fetchWindow = async (windowIndex: number): Promise<string[]> => {
      atWindow(windowIndex);
      const detailGets: string[] = [];
      const http = {
        text: vi.fn(async (u: string) => {
          if (u.endsWith('/sitemap.xml')) return syntheticSitemap(72);
          detailGets.push(u);
          return detailPage({ terms: [termRow({ code: u })] });
        }),
        json: vi.fn(),
      } as unknown as SourceContext['http'];
      await adventura.fetchOffers(makeCtx(http));
      vi.restoreAllMocks();
      return detailGets;
    };

    const run1 = await fetchWindow(0);
    const run2 = await fetchWindow(1);
    const run3 = await fetchWindow(2);

    expect(run1.length).toBe(MAX_DETAILS);
    expect(run2.length).toBe(72 - MAX_DETAILS);
    expect(new Set([...run1, ...run2]).size).toBe(72); // full coverage in one 2-run cycle
    expect(run1.some((u) => run2.includes(u))).toBe(false); // windows partition, never overlap
    expect(run3).toEqual(run1); // and the cycle repeats
  });

  it('logs the rotation truthfully (which window, and that the rest come next run)', async () => {
    atWindow(0);
    const http = {
      text: vi.fn(async (u: string) => {
        if (u.endsWith('/sitemap.xml')) return syntheticSitemap(72);
        return detailPage({ terms: [termRow({ code: u })] });
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    const ctx = makeCtx(http);
    await adventura.fetchOffers(ctx);
    const logs = (ctx.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    // The old wording was "(39 skipped this run)" — run-scoped phrasing for a set that never
    // changed. The replacement must name the window and promise the remainder (finding 5).
    expect(logs.some((l) => /rotating window 1\/2/.test(l) && /covered by the next 1 run/.test(l))).toBe(true);
    expect(logs.some((l) => /skipped this run/.test(l))).toBe(false);
  });

  it('warns when the catalogue outgrows a 2-run cycle (offers would flap inactive)', async () => {
    atWindow(0);
    const http = {
      text: vi.fn(async (u: string) => {
        if (u.endsWith('/sitemap.xml')) return syntheticSitemap(120); // 120 / 39 = 4 windows
        return detailPage({ terms: [termRow({ code: u })] });
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    const ctx = makeCtx(http);
    await adventura.fetchOffers(ctx);
    expect(ctx.log as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.stringContaining('WARNING'));
  });

  it('isolates a per-detail-URL error: skips the failing page, keeps the rest', async () => {
    atWindow(0);
    const http = {
      text: vi.fn(async (u: string) => {
        if (u.endsWith('/sitemap.xml')) return sitemapExcerpt;
        if (u.includes('11967-sri-lanka')) throw new Error('detail 500');
        return detailPage({ terms: [termRow({ code: u })] });
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    const ctx = makeCtx(http);
    const offers = await adventura.fetchOffers(ctx);
    expect(offers.length).toBe(13); // 14 selected - 1 failed
    expect(ctx.log as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.stringContaining('sri-lanka'));
  });

  it('stops further detail fetches on SourceBlockedError but keeps offers collected so far', async () => {
    atWindow(0);
    let detailCount = 0;
    const http = {
      text: vi.fn(async (u: string) => {
        if (u.endsWith('/sitemap.xml')) return sitemapExcerpt;
        detailCount += 1;
        if (detailCount === 2) throw new SourceBlockedError(403, 'blocked');
        return detailPage({ terms: [termRow({ code: u })] });
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    const offers = await adventura.fetchOffers(makeCtx(http));
    // 1st detail ok (1 offer), 2nd blocked -> stop. No further fetches.
    expect(offers.length).toBe(1);
    expect(detailCount).toBe(2);
  });

  it('rethrows when ALL detail pages fail (sitemap ok) so runScan marks the source failed', async () => {
    // sitemap OK but every detail GET fails -> not "market empty", rethrow the last error
    // (sibling convention) so runScan records 'failed' rather than degrading to [].
    atWindow(0);
    const http = {
      text: vi.fn(async (u: string) => {
        if (u.endsWith('/sitemap.xml')) return sitemapExcerpt;
        throw new Error('detail 500');
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    await expect(adventura.fetchOffers(makeCtx(http))).rejects.toThrow('detail 500');
  });

  it('rethrows when the FIRST detail page is blocked before any success (backoff must engage)', async () => {
    atWindow(0);
    const http = {
      text: vi.fn(async (u: string) => {
        if (u.endsWith('/sitemap.xml')) return sitemapExcerpt;
        throw new SourceBlockedError(403, 'blocked');
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    await expect(adventura.fetchOffers(makeCtx(http))).rejects.toThrow('blocked');
  });

  it('rethrows when the sitemap fetch itself fails (nothing to scan without it)', async () => {
    const http = {
      text: vi.fn(async () => {
        throw new Error('sitemap outage');
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    await expect(adventura.fetchOffers(makeCtx(http))).rejects.toThrow('sitemap outage');
  });

  it('dedupes globally by sourceOfferKey across tour pages', async () => {
    atWindow(0);
    // Two different tour pages surface the same order code -> one offer.
    const http = {
      text: vi.fn(async (u: string) => {
        if (u.endsWith('/sitemap.xml')) return sitemapExcerpt;
        return detailPage({ terms: [termRow({ code: 'SHARED' })] });
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    const offers = await adventura.fetchOffers(makeCtx(http));
    expect(offers.length).toBe(1);
  });

  it('logs the summary line with offer and page counts', async () => {
    atWindow(0);
    const http = {
      text: vi.fn(async (u: string) => {
        if (u.endsWith('/sitemap.xml')) return sitemapExcerpt;
        return detailPage({ terms: [termRow({ code: u })] });
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    const ctx = makeCtx(http);
    await adventura.fetchOffers(ctx);
    expect(ctx.log as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.stringMatching(/adventura: fetched \d+ offers across \d+ tour pages/),
    );
  });
});
