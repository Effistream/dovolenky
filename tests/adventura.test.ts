import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  filterExoticTourUrls,
  parseAdventuraDetail,
  adventura,
  MAX_DETAILS,
  EXOTIC_SLUG_TOKENS,
} from '../src/sources/adventura.js';
import { offerKeyHash } from '../src/core/normalize.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sitemapExcerpt = readFileSync(join(__dirname, 'fixtures/adventura/sitemap-excerpt.xml'), 'utf-8');
const nepalFixture = readFileSync(join(__dirname, 'fixtures/adventura/detail-nepal-everest.html'), 'utf-8');
const reunionFixture = readFileSync(join(__dirname, 'fixtures/adventura/detail-reunion-mauricius.html'), 'utf-8');

const BASE = 'https://www.adventura.cz';

function makeCtx(http: SourceContext['http']): SourceContext {
  return { http, adults: 2, log: vi.fn() };
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

const NBSP = ' ';

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
}

function detailPage(o: PageOpts = {}): string {
  const title = o.title ?? 'Nepál – treking údolím Šerpů až k Everestu';
  const terms = o.terms ?? [termRow()];
  const included = o.included ?? 'průvodce CK, letenka Praha–Káthmándú–Praha, transfery';
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
      <div class="row"><div class="column fourth"><strong class="orange">V ceně nezahrnuto:</strong></div><div class="column three-fourths"><p>vízum, fakultativní snídaně lze zakoupit</p></div></div>
    </div>
  </body></html>`;
}

describe('EXOTIC_SLUG_TOKENS & MAX_DETAILS constants', () => {
  it('exposes MAX_DETAILS = 25', () => {
    expect(MAX_DETAILS).toBe(25);
  });
  it('includes the required exotic tokens', () => {
    for (const t of ['nepal', 'vietnam', 'sri-lanka', 'zanzibar', 'reunion', 'mauricius', 'jar', 'galapagy']) {
      expect(EXOTIC_SLUG_TOKENS).toContain(t);
    }
  });
});

describe('filterExoticTourUrls: sitemap excerpt (real URL shapes)', () => {
  const urls = filterExoticTourUrls(sitemapExcerpt);

  it('selects exactly the 8 exotic /zajezdy/{id}-{slug}/ detail URLs', () => {
    expect(urls).toEqual([
      `${BASE}/zajezdy/11836-nepal-treking-udolim-serpu-az-k-everestu/`,
      `${BASE}/zajezdy/11888-dominikanska-republika-turistika-a-koupani/`,
      `${BASE}/zajezdy/11967-sri-lanka-na-kole/`,
      `${BASE}/zajezdy/11974-kambodza-na-kole/`,
      `${BASE}/zajezdy/12088-tibetem-do-nepalu/`,
      `${BASE}/zajezdy/12469-jar-kapske-mesto-vino-a-narodni-parky/`,
      `${BASE}/zajezdy/12666-reunion-a-mauricius-turistika-a-koupani/`,
      `${BASE}/zajezdy/12931-kuba-autenticka/`,
    ]);
  });

  it('is deterministically (lexicographically) sorted', () => {
    expect([...urls].sort()).toEqual(urls);
  });

  it('excludes the "jarni-andalusie" false positive (jar substring in "jarní" = spring)', () => {
    expect(urls.some((u) => u.includes('jarni-andalusie'))).toBe(false);
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
    expect(o.board).toBe('unknown'); // "snídaně zakoupit" is NOT in V ceně zahrnuto -> no false BB
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

  it('returns [] when there is no date-list table', () => {
    expect(parseAdventuraDetail('<html><body><h1 class="top upper">X</h1></body></html>', url)).toEqual([]);
  });

  it('leaves country null when the title has no recognized country token', () => {
    const html = detailPage({ title: 'Kostarika a panamský průplav', terms: [termRow({ code: 'k' })] });
    expect(parseAdventuraDetail(html, url)[0]!.country).toBeNull();
  });
});

describe('adventura.fetchOffers: sitemap-bounded crawl', () => {
  it('GETs the sitemap once, then one GET per selected (capped) exotic detail URL', async () => {
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
    // 1 sitemap + 8 exotic details (excerpt has 8, under the 25 cap)
    expect(seen.length).toBe(9);
    expect(offers.length).toBe(8);
  });

  it('caps detail fetches at MAX_DETAILS and logs how many exotic URLs were skipped', async () => {
    // Build a synthetic sitemap with 30 exotic tour URLs -> only 25 fetched, 5 skipped.
    const locs = Array.from(
      { length: 30 },
      (_, i) => `<url><loc>${BASE}/zajezdy/${1000 + i}-nepal-tour-${String(i).padStart(2, '0')}/</loc></url>`,
    ).join('');
    const bigSitemap = `<?xml version="1.0"?><urlset>${locs}</urlset>`;
    const detailGets: string[] = [];
    const http = {
      text: vi.fn(async (u: string) => {
        if (u.endsWith('/sitemap.xml')) return bigSitemap;
        detailGets.push(u);
        return detailPage({ terms: [termRow({ code: u })] });
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    await adventura.fetchOffers(ctx);
    expect(detailGets.length).toBe(25);
    expect(ctx.log as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.stringContaining('5'));
  });

  it('isolates a per-detail-URL error: skips the failing page, keeps the rest', async () => {
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
    expect(offers.length).toBe(7); // 8 selected - 1 failed
    expect(ctx.log as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(expect.stringContaining('sri-lanka'));
  });

  it('stops further detail fetches on SourceBlockedError but keeps offers collected so far', async () => {
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
    // Item 3: sitemap OK but every detail GET fails -> not "market empty", rethrow the last error
    // (sibling convention) so runScan records 'failed' rather than degrading to [].
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
