import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseZajezdy,
  zajezdyAllowedNow,
  zajezdy,
  fetchZajezdyOffers,
  zajezdyPageUrls,
} from '../src/sources/zajezdy.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(__dirname, `fixtures/zajezdy/${name}.html`), 'utf-8');
const reckoFixture = fixture('recko');
const allInclusiveFixture = fixture('all-inclusive');
// Captured live 2026-07-29 (Chrome UA, 5s crawl-delay honored) from
// https://last-minute.zajezdy.cz/chorvatsko/ and /maledivy/ — the two shapes the old fixtures
// did not cover: non-flight transport (doprava 1/5) and long-haul flights.
const chorvatskoFixture = fixture('chorvatsko');
const maledivyFixture = fixture('maledivy');

// Fixed reference time for all parseZajezdy calls in this suite: date-inference (year
// rollover) and the crawl-window gating both depend on `now`, so a fixed value keeps
// assertions (e.g. hardcoded '2026-07-15' departure dates) stable regardless of the real
// clock — without this, the suite would start failing once the real month passes July.
const FIXED_NOW = new Date('2026-07-04T09:00:00Z');

function makeCtx(http: SourceContext['http']): SourceContext {
  return {
    http,
    adults: 2,
    log: vi.fn(),
  };
}

describe('parseZajezdy', () => {
  const offers = parseZajezdy(reckoFixture, FIXED_NOW);

  it('expands 10 tourResults x 3 departures into 30 offers (offer = hotel + term)', () => {
    // Verified against the live fixture: 10 tourResults, each carrying exactly 3 departures.
    expect(offers.length).toBe(30);
  });

  it('parses the first offer with real values from the fixture', () => {
    const first = offers[0];
    expect(first).toBeDefined();
    expect(first!.title).toBe('Eri Village & Waterpark');
    expect(first!.country).toBe('Řecko');
    expect(first!.locality).toBe('Kréta');
    expect(first!.stars).toBe(4);
    expect(first!.pricePerPerson).toBe(19477);
    expect(first!.departureDate).toBe('2026-07-15');
    expect(first!.nights).toBe(7);
    expect(first!.board).toBe('AI');
    expect(first!.departureAirport).toBe('Praha');
    expect(first!.transport).toBe('flight');
    expect(first!.source).toBe('zajezdy');
    expect(first!.tourOperator).toBe('Join Up');
    expect(first!.url).toBe(
      'https://last-minute.zajezdy.cz/dovolena-eri-village-waterpark-kreta-recko-z3117506/2851209183/?f=1037311&index=0&typ=3&zeme=z211',
    );
  });

  it('parses claimedDiscountPct/claimedOriginalPrice from poSleve, including the &nbsp; variant', () => {
    // Fixture: first tour's first departure carries `poSleve: "po slevě 36&nbsp;%"`.
    const first = offers[0];
    expect(first!.claimedDiscountPct).toBe(36);
    expect(first!.claimedOriginalPrice).toBe(Math.round(19477 / (1 - 36 / 100)));
    expect(first!.claimedOriginalPrice as number).toBeGreaterThan(first!.pricePerPerson);
  });

  it('treats an empty poSleve label as no claimed discount', () => {
    // Fixture: Eri Village & Waterpark's 2nd/3rd departures carry poSleve: "".
    const noDiscountOffers = offers.filter(
      (o) => o.title === 'Eri Village & Waterpark' && o.departureDate !== '2026-07-15',
    );
    expect(noDiscountOffers.length).toBeGreaterThan(0);
    for (const o of noDiscountOffers) {
      expect(o.claimedDiscountPct).toBeNull();
      expect(o.claimedOriginalPrice).toBeNull();
    }
  });

  it('uses the raw date span as nights for short-haul flights (Řecko flies day schedules)', () => {
    // Verified against the site's own detail pages: Řecko/Turecko/Egypt charter terms print
    // "N dní, N-1 nocí", i.e. nights == the odjezdPrijezd span exactly.
    const nightsSeen = new Set(offers.map((o) => o.nights));
    expect(nightsSeen.has(7)).toBe(true);
    expect(nightsSeen.has(11)).toBe(true); // "St 15. 7. – Ne 26. 7." (11 nights)
    for (const o of offers) expect(o.nights).not.toBeNull();
  });

  it('holds invariants for every offer', () => {
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(o.source).toBe('zajezdy');
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(Number.isInteger(o.pricePerPerson)).toBe(true);
      expect(o.url.startsWith('https://last-minute.zajezdy.cz/')).toBe(true);
      expect(o.title.length).toBeGreaterThan(0);
      expect(o.sourceOfferKey.length).toBeGreaterThan(0);
      expect(o.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.nights as number).toBeGreaterThan(0);
    }
  });

  it('deduplicates offers by sourceOfferKey (unique per tour+term)', () => {
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('returns an empty array for HTML without window.searchData', () => {
    expect(parseZajezdy('<html><body>no data here</body></html>', FIXED_NOW)).toEqual([]);
  });
});

describe('parseZajezdy: generic-slug fixture (all-inclusive)', () => {
  // Live fixture captured from the generic /all-inclusive/ slug (not a single-country slug
  // like /recko/), so tour.countryName varies per tourResult. Guards against `country`
  // regressing to a locality/city string for generic-slug pages.
  const offers = parseZajezdy(allInclusiveFixture, FIXED_NOW);
  const EXPECTED_COUNTRIES = new Set(['Řecko', 'Turecko']);

  it('parses a non-empty offer list', () => {
    expect(offers.length).toBeGreaterThan(0);
  });

  it('normalizes every offer country to null or a canonical country name', () => {
    for (const o of offers) {
      expect(o.country === null || EXPECTED_COUNTRIES.has(o.country as string)).toBe(true);
    }
  });
});

describe('parseZajezdy: transport + nights from the numeric doprava code (chorvatsko fixture)', () => {
  const offers = parseZajezdy(chorvatskoFixture, FIXED_NOW);

  it('maps doprava 5 -> own and doprava 1 -> bus instead of falling back to unknown', () => {
    // Regression: transport used to be derived solely from `letiste`, so all 30 Croatian
    // offers (21 x doprava=5 "autem", 9 x doprava=1 "autobusem") landed on 'unknown'.
    // normalizeTransport() cannot rescue them either — it does not recognise the literal
    // label "autem" — which is why the numeric code is what we map.
    const byTransport = offers.reduce<Record<string, number>>((acc, o) => {
      acc[o.transport] = (acc[o.transport] ?? 0) + 1;
      return acc;
    }, {});
    expect(byTransport.unknown).toBeUndefined();
    expect(byTransport.own).toBeGreaterThan(0);
    expect(byTransport.bus).toBeGreaterThan(0);
    expect(byTransport.own! + byTransport.bus!).toBe(offers.length);
  });

  it('subtracts the two overnight coach legs on bus terms and nothing on self-drive terms', () => {
    // Every hotel in this fixture sells the same 7-night stay twice: (8 dní) by car and
    // (10 dní) by coach. Verified against the site's own detail pages (Pokoje LJUBA and
    // Vila Juroš both print "10 dní, 7 nocí"; Penzion BARTULOVIĆ prints "8 dní, 7 nocí").
    expect(new Set(offers.filter((o) => o.transport === 'own').map((o) => o.nights))).toEqual(new Set([7]));
    expect(new Set(offers.filter((o) => o.transport === 'bus').map((o) => o.nights))).toEqual(new Set([7]));
  });

  it('maps every field of the live-verified Penzion BARTULOVIĆ self-drive term', () => {
    // Cross-checked against https://last-minute.zajezdy.cz/dovolena-penzion-bartulovic-
    // makarska-riviera-chorvatsko-z2610188/2632055594/ : "Cena 7 633 Kč/os", "24. 8. – 31. 8.
    // 2026, 8 dní, 7 nocí", "Doprava Autem", "Polopenze", and the page's own embedded JSON
    // "discount":15,"cataloguePrice":8980.00.
    const o = offers.find((x) => x.title === 'Penzion BARTULOVIĆ' && x.pricePerPerson === 7633);
    expect(o).toBeDefined();
    expect(o!.country).toBe('Chorvatsko');
    expect(o!.locality).toBe('Makarská riviéra, Střední Dalmácie');
    expect(o!.board).toBe('HB');
    expect(o!.transport).toBe('own');
    expect(o!.departureAirport).toBeNull();
    expect(o!.departureDate).toBe('2026-08-24');
    expect(o!.nights).toBe(7);
    expect(o!.claimedDiscountPct).toBe(15);
    expect(o!.claimedOriginalPrice).toBe(8980);
    expect(o!.tourOperator).toBe('KM Travel');
    expect(o!.url).toContain('/dovolena-penzion-bartulovic-makarska-riviera-chorvatsko-z2610188/2632055594/');
  });
});

describe('parseZajezdy: long-haul flights withhold nights (maledivy fixture)', () => {
  const offers = parseZajezdy(maledivyFixture, FIXED_NOW);

  it('emits the offers but with nights null, because the span is not the night count', () => {
    // 18 live detail pages give span -> nights of 7->7, 8->7, 9->7, 10->8, 10->7, 12->12,
    // 13->12, 14->12, 15->12: the travel-night loss runs 0..3 and is not a function of
    // anything the listing publishes. A wrong count would understate price-per-night by up
    // to 30% and manufacture a "real discount"; null just skips the per-night rungs.
    expect(offers.length).toBe(30);
    for (const o of offers) {
      expect(o.country).toBe('Maledivy');
      expect(o.transport).toBe('flight');
      expect(o.nights).toBeNull();
    }
  });

  it('still carries price, date, board, stars, operator and the claimed poSleve discount', () => {
    const o = offers.find((x) => x.title === 'Sandies Bathala' && x.pricePerPerson === 88310);
    expect(o).toBeDefined();
    expect(o!.departureDate).toBe('2026-08-22');
    expect(o!.board).toBe('AI');
    expect(o!.stars).toBe(4);
    expect(o!.departureAirport).toBe('Praha');
    expect(o!.tourOperator).toBe('Exim tours');
    expect(o!.claimedDiscountPct).toBe(17);
    expect(offers.filter((x) => x.claimedDiscountPct !== null).length).toBeGreaterThan(0);
    expect(offers.every((x) => x.departureDate !== null)).toBe(true);
  });

  it('keeps sourceOfferKey stable and unique even though nights is null', () => {
    // The key hashes the raw calendar span, not the derived nights, so nulling nights neither
    // collides keys nor re-keys offers that already exist in the DB.
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/**
 * Synthetic single-departure listing payload. The four live fixtures cover the common shapes,
 * but three branches that DO fire on live pages are absent from all of them: a coach term
 * shorter than its two overnight legs (live: "Jednodenní koupání - ISTRIE", 3 offers on
 * /nejlevnejsi-chorvatsko/), a destination outside SHORT_HAUL_COUNTRIES that is not one of the
 * fixture countries (live: Bahamy, 16 offers via /letecky-praha/), and a departure with no
 * `doprava` code at all. Built inline rather than captured so the input is exact.
 */
function syntheticListing(departures: Record<string, unknown>[]): string {
  const searchData = {
    tourResults: departures.map((dep, i) => {
      const { countryName, ...departure } = dep as { countryName?: string };
      return {
        tour: {
          name: `Hotel ${i}`,
          countryName: countryName ?? 'Chorvatsko',
          dest: 'Testovací letovisko',
          ckName: 'CK Test',
          baseUrl: `/dovolena-hotel-${i}-z${900000 + i}/`,
        },
        departures: [
          {
            totalAdultPrice: { amount: 10000 + i, currency: 'CZK' },
            strava: 'polopenze',
            url: { url: `https://last-minute.zajezdy.cz/dovolena-hotel-${i}-z${900000 + i}/${i}/` },
            ...departure,
          },
        ],
      };
    }),
  };
  return `<html><body><script>window.searchData = ${JSON.stringify(searchData)};</script></body></html>`;
}

describe('parseZajezdy: nights/transport edge cases the live fixtures do not contain', () => {
  it('withholds nights on a coach term too short to survive its two overnight legs', () => {
    // Live on /nejlevnejsi-chorvatsko/: "Jednodenní koupání - ISTRIE", 1 190 Kč, a one-day
    // coach trip with zero hotel nights. span-2 would be <= 0, which is not a stay — null,
    // never 0 (a 0 would sail into discount.ts's `current / nights`).
    const offers = parseZajezdy(
      syntheticListing([
        { odjezdPrijezd: 'Pá 7. 8. – So 8. 8.', doprava: 1 }, // span 1
        { odjezdPrijezd: 'Pá 7. 8. – Ne 9. 8.', doprava: 1 }, // span 2
        { odjezdPrijezd: 'Pá 7. 8. – Po 10. 8.', doprava: 1 }, // span 3 -> 1 night
      ]),
      FIXED_NOW,
    );
    expect(offers.map((o) => o.transport)).toEqual(['bus', 'bus', 'bus']);
    expect(offers.map((o) => o.nights)).toEqual([null, null, 1]);
    // The offers themselves survive: price/date/url are untouched by the nights decision.
    for (const o of offers) {
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(o.departureDate).toBe('2026-08-07');
    }
  });

  it('withholds nights for a flight to a country outside the short-haul allow-list', () => {
    // Live: /letecky-praha/ contributes Bahamy, which is not in SHORT_HAUL_COUNTRIES and is not
    // even a canonical country name (normalizeCountry passes it through). An unrecognised
    // destination must degrade to null, not to a span-shaped guess.
    const [bahamy, recko] = parseZajezdy(
      syntheticListing([
        { odjezdPrijezd: 'So 1. 8. – Ne 9. 8.', doprava: 2, letiste: 'Praha', countryName: 'Bahamy' },
        { odjezdPrijezd: 'So 1. 8. – Ne 9. 8.', doprava: 2, letiste: 'Praha', countryName: 'Řecko' },
      ]),
      FIXED_NOW,
    );
    expect(bahamy!.country).toBe('Bahamy');
    expect(bahamy!.transport).toBe('flight');
    expect(bahamy!.nights).toBeNull();
    // Same span, same transport, allow-listed country -> the span IS the night count.
    expect(recko!.country).toBe('Řecko');
    expect(recko!.nights).toBe(8);
  });

  it('falls back to the airport only when no doprava code is present', () => {
    const offers = parseZajezdy(
      syntheticListing([
        { odjezdPrijezd: 'So 1. 8. – So 8. 8.', letiste: 'Praha' }, // no code, has airport
        { odjezdPrijezd: 'So 1. 8. – So 8. 8.' }, // no code, no airport
        { odjezdPrijezd: 'So 1. 8. – So 8. 8.', doprava: 13 }, // "bez dopravy"
        { odjezdPrijezd: 'So 1. 8. – So 8. 8.', doprava: 5 },
      ]),
      FIXED_NOW,
    );
    expect(offers.map((o) => o.transport)).toEqual(['flight', 'unknown', 'own', 'own']);
    // doprava 13 ("bez dopravy") and 5 ("autem") are both accommodation-only as far as nights go.
    expect(offers.map((o) => o.nights)).toEqual([7, 7, 7, 7]);
  });
});

describe('zajezdy: request budget', () => {
  // src/core/run.ts aborts an adapter at ADAPTER_FETCH_TIMEOUT_MS = 240s and records the source
  // 'failed' (removing it from the board entirely); scan.ts pins a 5s host gap for
  // last-minute.zajezdy.cz. This test is the guard rail: the page list must stay inside the cap
  // and one run must issue exactly one request per page — no hidden pagination.
  const HARD_CAP = 20;

  it('never plans more than the documented request cap', () => {
    expect(zajezdyPageUrls().length).toBeLessThanOrEqual(HARD_CAP);
    expect(zajezdyPageUrls().length).toBeGreaterThan(0);
  });

  it('asks for the site page-size parameter on every page and nothing robots disallows', () => {
    for (const url of zajezdyPageUrls()) {
      expect(url).toMatch(/^https:\/\/last-minute\.zajezdy\.cz\/[a-z0-9-]+\/\?max=\d+$/);
      // robots.txt (User-agent: *) disallows these query params.
      expect(url).not.toMatch(/[?&](page|index|stars|delka|strava|doprava|dospelych)=/);
      expect(url).not.toMatch(/cena\.(min|max)=/);
    }
  });

  it('issues exactly one HTTP request per planned page and no more', async () => {
    const urls = zajezdyPageUrls();
    const calledUrls: string[] = [];
    const http = {
      text: vi.fn(async (url: string) => {
        calledUrls.push(url);
        return reckoFixture;
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    await fetchZajezdyOffers(makeCtx(http), FIXED_NOW);

    expect(calledUrls).toEqual(urls);
    expect(calledUrls.length).toBeLessThanOrEqual(HARD_CAP);
  });
});

describe('zajezdyAllowedNow: robots time window (08:00-24:00 Europe/Prague)', () => {
  it('is false at 07:00 Prague time', () => {
    // 2026-07-04 is CEST (UTC+2), so 07:00 Prague = 05:00 UTC.
    expect(zajezdyAllowedNow(new Date('2026-07-04T05:00:00Z'))).toBe(false);
  });

  it('is true at 09:00 Prague time', () => {
    // 09:00 Prague (CEST, UTC+2) = 07:00 UTC.
    expect(zajezdyAllowedNow(new Date('2026-07-04T07:00:00Z'))).toBe(true);
  });

  it('is true just after 08:00 Prague and false just before', () => {
    expect(zajezdyAllowedNow(new Date('2026-07-04T06:00:00Z'))).toBe(true); // 08:00 CEST
    expect(zajezdyAllowedNow(new Date('2026-07-04T05:59:00Z'))).toBe(false); // 07:59 CEST
  });

  it('is false at/after midnight Prague time', () => {
    expect(zajezdyAllowedNow(new Date('2026-07-04T22:00:00Z'))).toBe(false); // 00:00 CEST (next day)
  });
});

describe('zajezdy: SourceAdapter conformance', () => {
  it('exposes name "zajezdy" and a fetchOffers(ctx) function usable as a plain SourceAdapter', () => {
    expect(zajezdy.name).toBe('zajezdy');
    expect(typeof zajezdy.fetchOffers).toBe('function');
  });
});

describe('zajezdy.fetchOffers: per-page error isolation', () => {
  it('skips fetching entirely and logs when outside the allowed time window', async () => {
    const http = { text: vi.fn(), json: vi.fn() } as unknown as SourceContext['http'];
    const ctx = makeCtx(http);
    const offers = await fetchZajezdyOffers(ctx, new Date('2026-07-04T05:00:00Z'));
    expect(offers).toEqual([]);
    expect(http.text).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('skip'));
  });

  it('continues past a generic error on one page and returns offers from the others', async () => {
    const [firstUrl, secondUrl] = zajezdyPageUrls();
    const http = {
      text: vi.fn(async (url: string) => {
        if (url === firstUrl) return reckoFixture;
        if (url === secondUrl) throw new Error('network hiccup');
        return '<html><body>window.searchData = {"tourResults":[]};</body></html>';
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await fetchZajezdyOffers(ctx, FIXED_NOW);

    expect(offers.length).toBe(30);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('network hiccup'));
  });

  it('stops fetching remaining pages on SourceBlockedError but returns offers collected so far', async () => {
    const [firstUrl, secondUrl] = zajezdyPageUrls();
    const calledUrls: string[] = [];
    const http = {
      text: vi.fn(async (url: string) => {
        calledUrls.push(url);
        if (url === firstUrl) return reckoFixture;
        if (url === secondUrl) throw new SourceBlockedError(403, 'blocked');
        throw new Error(`should not fetch ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await fetchZajezdyOffers(ctx, FIXED_NOW);

    expect(offers.length).toBe(30);
    // Only the first page (success) and the second (blocked, then stop) should have been requested.
    expect(calledUrls).toEqual([firstUrl, secondUrl]);
  });

  it('rethrows when the FIRST page is blocked before any success (backoff must engage)', async () => {
    // Regression: a block on the first page (before any success) must propagate (not swallow to
    // []), so runScan writes the BLOCKED marker and the 24h backoff engages.
    const [firstUrl] = zajezdyPageUrls();
    const http = {
      text: vi.fn(async (url: string) => {
        if (url === firstUrl) throw new SourceBlockedError(403, 'blocked');
        throw new Error(`should not fetch ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    await expect(fetchZajezdyOffers(makeCtx(http), FIXED_NOW)).rejects.toThrow('blocked');
  });

  it('rethrows when every page fails, so the source is recorded failed rather than emptied', async () => {
    const http = {
      text: vi.fn(async () => {
        throw new Error('DNS meltdown');
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];
    await expect(fetchZajezdyOffers(makeCtx(http), FIXED_NOW)).rejects.toThrow('DNS meltdown');
  });
});
