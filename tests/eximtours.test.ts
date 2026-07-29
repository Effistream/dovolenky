import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseEximSeeds,
  parseEximSearch,
  buildSearchUrl,
  eximtours,
  PAGE_SIZE,
  MAX_SEARCH_REQUESTS,
} from '../src/sources/eximtours.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lastMinuteHtml = readFileSync(join(__dirname, 'fixtures/eximtours/last-minute.html'), 'utf-8');
const searchFixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/eximtours/getsearch.json'), 'utf-8'));
// Trimmed live capture 2026-07-29: Thajsko DS=2 cards ('bez stravy' room-only wording) plus
// Kapverdy cards ('Kapverdské ostrovy' country label). paging.Count is Řecko's live 1355, so the
// adapter sees a destination big enough to keep paging.
const mixedFixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/eximtours/getsearch-mixed.json'), 'utf-8'));

const seedCount = parseEximSeeds(lastMinuteHtml).length;

function makeCtx(overrides: { text?: unknown; json?: unknown } = {}) {
  const textMock = (overrides.text as ReturnType<typeof vi.fn>) ?? vi.fn().mockResolvedValue(lastMinuteHtml);
  const jsonMock = (overrides.json as ReturnType<typeof vi.fn>) ?? vi.fn().mockResolvedValue(mixedFixture);
  const log = vi.fn();
  const ctx: SourceContext = {
    http: { json: jsonMock, text: textMock } as unknown as SourceContext['http'],
    adults: 2,
    log,
  };
  return { ctx, textMock, jsonMock, log };
}

describe('parseEximSeeds', () => {
  const seeds = parseEximSeeds(lastMinuteHtml);

  it('extracts at least 5 destinations with a searchUrl', () => {
    expect(seeds.length).toBeGreaterThanOrEqual(5);
    for (const seed of seeds) {
      expect(seed.name.length).toBeGreaterThan(0);
      expect(seed.searchUrl).toContain('vysledky-vyhledavani');
    }
  });

  it('includes Egypt and Řecko with a real searchUrl (hardcoded from the fixture)', () => {
    const egypt = seeds.find((s) => s.name === 'Egypt');
    const recko = seeds.find((s) => s.name === 'Řecko');
    expect(egypt).toBeDefined();
    expect(recko).toBeDefined();
    expect(egypt!.searchUrl).toBe(
      '/vysledky-vyhledavani?ds=0&tt=1&d=64419%7c64420%7c64422%7c64423%7c64424%7c64425&dd=2026-07-05&rd=2026-09-02&er=0&isss=0&nn=7%7c10%7c14&ac1=2&kc1=0&ic1=0',
    );
    expect(recko!.searchUrl).toContain('d=63219%7c63220');
  });
});

describe('buildSearchUrl', () => {
  it('re-targets the seed querystring at /searchresult/getsearch and appends the paging params', () => {
    const url = buildSearchUrl('/vysledky-vyhledavani?ds=0&tt=1&d=63219&nn=7%7c10%7c14&ac1=2', 40);
    expect(url).toBe(
      `https://www.eximtours.cz/searchresult/getsearch?ds=0&tt=1&d=63219&nn=7%7c10%7c14&ac1=2&pSTG=40&pITG=${PAGE_SIZE}`,
    );
  });

  it('asks for 40 rows — the measured server-side ceiling (pITG>=50 returns an HTML error page)', () => {
    expect(PAGE_SIZE).toBe(40);
    expect(buildSearchUrl('/x?a=1', 0)).toContain('&pSTG=0&pITG=40');
  });
});

describe('parseEximSearch (fixture)', () => {
  const offers = parseEximSearch(searchFixture);

  it('parses all 20 cards from the HTML field (no silent drops)', () => {
    expect(offers.length).toBe(20);
  });

  it('maps the first card (Rewaya Inn Resort ex. Hawaii Paradise) with hardcoded real values', () => {
    const first = offers[0]!;
    expect(first.source).toBe('eximtours');
    expect(first.title).toBe('Rewaya Inn Resort ex. Hawaii Paradise');
    expect(first.country).toBe('Egypt');
    expect(first.locality).toBe('Hurghada');
    expect(first.stars).toBe(5);
    expect(first.board).toBe('AI');
    expect(first.pricePerPerson).toBe(13590);
    expect(first.priceTotal).toBe(27180);
    expect(first.claimedOriginalPrice).toBe(25550); // round(51100/2), adults=round(27180/13590)=2
    expect(first.claimedDiscountPct).toBe(47); // round(23920/51100*100)
    expect(first.departureDate).toBe('2026-07-09');
    expect(first.nights).toBe(7);
    expect(first.transport).toBe('flight');
    expect(first.url.startsWith('https://www.eximtours.cz/egypt/hurghada/hurghadahawaii-paradise')).toBe(true);
  });

  it('derives a per-person claimedOriginalPrice from the TOTAL-based originalPrice/discount', () => {
    // Empirical finding (verified against all 20 cards in both the Egypt and Řecko fixtures,
    // zero mismatches): js-roomPrice-originalPrice minus js-totalDiscount--amount always equals
    // js-roomPrice-total exactly (e.g. 51100 - 23920 = 27180 = 2 * adult0's 13590). So
    // originalPrice/discount are TOTAL-based figures (like eTravel/DER — see der.ts), NOT
    // per-person, even though adult0 alone is per-person. claimedOriginalPrice is converted to
    // per-person (dividing by the derived adult count) to match every sibling adapter's
    // claimedOriginalPrice contract, so it must exceed pricePerPerson, not priceTotal.
    for (const offer of offers) {
      if (offer.claimedOriginalPrice !== null && offer.pricePerPerson !== null) {
        expect(offer.claimedOriginalPrice).toBeGreaterThan(offer.pricePerPerson);
      }
    }
  });

  it('every offer with a claimed discount has a plausible pct (1..90)', () => {
    for (const offer of offers) {
      if (offer.claimedDiscountPct !== null) {
        expect(offer.claimedDiscountPct).toBeGreaterThan(0);
        expect(offer.claimedDiscountPct).toBeLessThan(100);
      }
    }
  });

  it('enforces invariants: positive price, absolute eximtours.cz url, correct source tag', () => {
    for (const offer of offers) {
      expect(offer.pricePerPerson).toBeGreaterThan(0);
      expect(offer.url.startsWith('https://www.eximtours.cz')).toBe(true);
      expect(offer.source).toBe('eximtours');
      expect(offer.sourceOfferKey.length).toBeGreaterThan(0);
    }
  });

  it('produces a canonical country or null, never a locality/city value', () => {
    for (const offer of offers) {
      expect(offer.country === null || typeof offer.country === 'string').toBe(true);
      if (offer.country !== null) {
        expect(offer.country).not.toBe(offer.locality);
      }
    }
  });

  it('parses dates directly (both start/end dates carry a full 4-digit year in this source)', () => {
    for (const offer of offers) {
      if (offer.departureDate) {
        expect(offer.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('dedupes cards sharing the same title/date/nights/board key', () => {
    const html = (searchFixture as { HTML: string }).HTML;
    const duplicated = { ...searchFixture, HTML: html + html };
    const withDup = parseEximSearch(duplicated);
    expect(withDup.length).toBe(offers.length);
  });
});

describe('parseEximSearch — field fixes (live capture 2026-07-29)', () => {
  const offers = parseEximSearch(mixedFixture);
  const byTitle = new Map(offers.map((o) => [o.title, o]));

  it('parses every card in the trimmed capture', () => {
    expect(offers.length).toBe(4);
  });

  it("maps the DS=2 room-only wording 'bez stravy' to board 'none', not 'unknown'", () => {
    // Regression for the old /…|Bez stravování/ pattern: it only knew the long wording, so the
    // dynamic-packaging cards fell through to 'unknown' — and board 'unknown' makes
    // computeMatchKey return null, dropping the offer out of cross-source matching entirely.
    const phuket = byTitle.get('Phuket Sea Resort SHA by ZUZU')!;
    expect(phuket.board).toBe('none');
    expect(phuket.country).toBe('Thajsko');
    expect(phuket.pricePerPerson).toBe(16721);
    expect(phuket.priceTotal).toBe(33443);
    expect(phuket.departureDate).toBe('2026-09-18');
    expect(phuket.nights).toBe(7);
    expect(phuket.stars).toBe(4);
  });

  it("still maps the long wording 'Bez stravování' to 'none' and 'snídaně' to BB", () => {
    expect(byTitle.get('Hotel Da Luz')!.board).toBe('none');
    expect(byTitle.get('Nai Yang Beach Resort & Spa')!.board).toBe('BB');
  });

  it("canonicalizes the site's 'Kapverdské ostrovy' label to the country 'Kapverdy'", () => {
    // normalize.ts's COUNTRY_BY_KEY only knows the bare 'Kapverdy', so the isKnownCountry guard
    // used to null these out — which silently excluded every Cape Verde offer from the `exotika`
    // profile that names Kapverdy, from computeMatchKey and from computeHotelKey.
    const belorizonte = byTitle.get('OA Belorizonte')!;
    expect(belorizonte.country).toBe('Kapverdy');
    expect(belorizonte.locality).toBe('Santa Maria Sal');
    expect(belorizonte.stars).toBe(4);
    expect(belorizonte.board).toBe('AI');
    expect(belorizonte.departureDate).toBe('2026-08-18');
    expect(belorizonte.nights).toBe(7);
    expect(belorizonte.pricePerPerson).toBe(26090);
    expect(belorizonte.priceTotal).toBe(52180);
    expect(belorizonte.claimedOriginalPrice).toBe(32540); // round(65080/2)
    expect(belorizonte.claimedDiscountPct).toBe(20);
    expect(byTitle.get('Hotel Da Luz')!.country).toBe('Kapverdy');
  });

  it('leaves no offer with board unknown in this capture', () => {
    expect(offers.filter((o) => o.board === 'unknown')).toHaveLength(0);
  });
});

// The board fix has TWO independent halves (structured `dimension15` primary + widened free-text
// fallback) and on the live fixture BOTH resolve every card, so an assertion on the finished board
// value cannot tell them apart — mutation-checked 2026-07-29: reverting the regex to the old
// literal, or disabling the gtm branch outright, left the suite at 25/25 green. These two tests
// isolate each half so a regression in either one fails on its own.
describe('parseEximSearch — board sources isolated', () => {
  const html = (mixedFixture as { HTML: string }).HTML;

  it('resolves the DS=2 "bez stravy" wording from free text alone when the gtm payload is absent', () => {
    // Same live cards with every data-gtm-impression attribute removed, i.e. only BOARD_TEXT_RE
    // can answer. With the pre-fix /…|Bez stravování/ pattern this card matched nothing and fell
    // through to 'unknown' — which makes computeMatchKey return null and drops the offer out of
    // cross-source matching. The other three cards pin the wordings the old pattern already knew.
    const noGtm = parseEximSearch({ HTML: html.replace(/ data-gtm-impression="[^"]*"/g, '') });
    const byTitle = new Map(noGtm.map((o) => [o.title, o]));
    expect(noGtm).toHaveLength(4);
    expect(byTitle.get('Phuket Sea Resort SHA by ZUZU')!.board).toBe('none');
    expect(byTitle.get('Hotel Da Luz')!.board).toBe('none');
    expect(byTitle.get('Nai Yang Beach Resort & Spa')!.board).toBe('BB');
    expect(byTitle.get('OA Belorizonte')!.board).toBe('AI');
  });

  it('prefers the structured dimension15 over a contradicting free-text board string', () => {
    // Only the VISIBLE board paragraph is rewritten to 'Polopenze' (the escaped &quot;bez
    // stravy&quot; inside data-gtm-impression is untouched), so the two sources now disagree. The
    // structured label must win: the text search is positional (leftmost match) and therefore the
    // fragile one — measured live on 94 cards across Thajsko/Velká Británie/Španělsko, the
    // free-text answer differed from dimension15 on 36 of them.
    expect(html.match(/>bez stravy<\/p>/g)).toHaveLength(1);
    const decoyed = parseEximSearch({ HTML: html.replace('>bez stravy</p>', '>Polopenze</p>') });
    const phuket = decoyed.find((o) => o.title === 'Phuket Sea Resort SHA by ZUZU')!;
    expect(phuket.board).toBe('none'); // 'HB' would mean the decoy text beat dimension15
  });
});

describe('eximtours source adapter', () => {
  it('is named eximtours and never exceeds the request budget, however big the result sets are', async () => {
    // The whole point of the cap: src/core/run.ts aborts an adapter after 240 s and HttpClient
    // spends ~4 s per request, so an uncapped paging loop over a 1355-row destination would blow
    // the timeout and record the source 'failed' (= gone from the board entirely).
    const { ctx, textMock, jsonMock } = makeCtx();

    const offers = await eximtours.fetchOffers(ctx);

    expect(eximtours.name).toBe('eximtours');
    expect(textMock).toHaveBeenCalledTimes(1);
    // Every destination in the fixture reports Count 1355, so the loop would page forever.
    expect(jsonMock).toHaveBeenCalledTimes(MAX_SEARCH_REQUESTS);
    expect(MAX_SEARCH_REQUESTS).toBeLessThanOrEqual(40); // 40 x ~4 s stays inside the 240 s timeout
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.source === 'eximtours')).toBe(true);
  });

  it('queries every live seed once (breadth) before giving any destination a second page', async () => {
    const { ctx, jsonMock } = makeCtx();
    await eximtours.fetchOffers(ctx);

    const urls = jsonMock.mock.calls.map((c) => String(c[0]));
    const firstPass = urls.slice(0, seedCount);
    expect(firstPass).toHaveLength(seedCount);
    expect(firstPass.every((u) => u.includes('&pSTG=0&'))).toBe(true);
    // one distinct destination-id filter per request — no seed is queried twice in pass 0
    const destinations = new Set(firstPass.map((u) => new URL(u).searchParams.get('d')));
    expect(destinations.size).toBe(seedCount);

    // leftover budget goes to the next page of the biggest destinations
    const secondPass = urls.slice(seedCount);
    expect(secondPass).toHaveLength(MAX_SEARCH_REQUESTS - seedCount);
    expect(secondPass.every((u) => u.includes(`&pSTG=${PAGE_SIZE}&`))).toBe(true);
  });

  it('stops paging a destination once its own paging.Count is exhausted', async () => {
    // Count 4 < PAGE_SIZE, so one request per destination is the whole result set and the spare
    // budget must NOT be spent re-requesting rows that do not exist.
    const smallFixture = { ...mixedFixture, paging: { Count: 4, PageSize: 20, RowsToSkip: 0 } };
    const { ctx, jsonMock } = makeCtx({ json: vi.fn().mockResolvedValue(smallFixture) });

    await eximtours.fetchOffers(ctx);

    expect(jsonMock).toHaveBeenCalledTimes(seedCount);
    expect(jsonMock.mock.calls.every((c) => String(c[0]).includes('&pSTG=0&'))).toBe(true);
  });

  it('marks a failed page consumed — the same offset is never re-requested', async () => {
    // With the full 20-seed list the budget is exhausted by breadth+depth anyway, so a retry loop
    // is invisible there. One real seed makes the paging ladder observable: MAX_ROWS_PER_DESTINATION
    // caps it at rows 0/40/80. If the failed offset were NOT marked consumed, pSTG=40 would be
    // requested twice and the run would spend its budget re-hitting a poisoned offset.
    const recko = parseEximSeeds(lastMinuteHtml).find((s) => s.name === 'Řecko')!;
    const oneSeedHtml = `<script>var groupSearchResult = {"locations":${JSON.stringify([recko])}};</script>`;
    const big = { HTML: (mixedFixture as { HTML: string }).HTML, paging: { Count: 1355 } };
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce(big)
      .mockRejectedValueOnce(new Error('rows 40 down'))
      .mockResolvedValue(big);
    const { ctx } = makeCtx({ text: vi.fn().mockResolvedValue(oneSeedHtml), json: jsonMock });

    await eximtours.fetchOffers(ctx);

    const skips = jsonMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get('pSTG'));
    expect(skips).toEqual(['0', '40', '80']);
  });

  it('isolates a per-page request failure without sinking the whole fetch', async () => {
    const jsonMock = vi.fn().mockRejectedValueOnce(new Error('network blip')).mockResolvedValue(mixedFixture);
    const { ctx } = makeCtx({ json: jsonMock });

    const offers = await eximtours.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    // the failed page is marked consumed, so the budget is not burned retrying the same offset
    expect(jsonMock).toHaveBeenCalledTimes(MAX_SEARCH_REQUESTS);
  });

  it('rethrows a total last-minute seed fetch failure (so runScan records it failed, not empty)', async () => {
    const jsonMock = vi.fn();
    const { ctx } = makeCtx({ text: vi.fn().mockRejectedValue(new Error('seed down')), json: jsonMock });

    await expect(eximtours.fetchOffers(ctx)).rejects.toThrow('seed down');
    expect(jsonMock).not.toHaveBeenCalled();
  });

  it('stops issuing further requests on SourceBlockedError but keeps offers already collected', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce(mixedFixture)
      .mockRejectedValueOnce(new SourceBlockedError(403, 'blocked'));
    const { ctx } = makeCtx({ json: jsonMock });

    const offers = await eximtours.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    expect(jsonMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the FIRST request is blocked before any success (backoff must engage)', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    const jsonMock = vi.fn().mockRejectedValue(new SourceBlockedError(403, 'blocked'));
    const { ctx } = makeCtx({ json: jsonMock });

    await expect(eximtours.fetchOffers(ctx)).rejects.toThrow('blocked');
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('logs a sourceOfferKey collision instead of dropping the offer silently', async () => {
    // Same card served from two DIFFERENT destination queries under a different detail path: two
    // physically different hotels hashing to the same title|date|nights|board key. Without the
    // log the second one just vanishes from the run.
    const html = (mixedFixture as { HTML: string }).HTML;
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce({ HTML: html, paging: { Count: 1 } })
      .mockResolvedValue({ HTML: html.replaceAll('/hotely/thajsko/', '/hotely/kambodza/'), paging: { Count: 1 } });
    const { ctx, log } = makeCtx({ json: jsonMock });

    await eximtours.fetchOffers(ctx);

    const messages = log.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('sourceOfferKey collision'))).toBe(true);
  });
});
