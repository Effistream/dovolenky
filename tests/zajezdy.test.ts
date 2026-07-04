import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseZajezdy, zajezdyAllowedNow, zajezdy, fetchZajezdyOffers } from '../src/sources/zajezdy.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const reckoFixture = readFileSync(join(__dirname, 'fixtures/zajezdy/recko.html'), 'utf-8');
const allInclusiveFixture = readFileSync(join(__dirname, 'fixtures/zajezdy/all-inclusive.html'), 'utf-8');

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

  it('derives nights from the odjezdPrijezd date range (7/8/12-night departures present in fixture)', () => {
    const nightsSeen = new Set(offers.map((o) => o.nights));
    expect(nightsSeen.has(7)).toBe(true);
    expect(nightsSeen.has(11)).toBe(true); // "Ne 16. 8. – St 26. 8." (11 nights)
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

  it('continues past a generic error on one slug and returns offers from the others', async () => {
    const http = {
      text: vi.fn(async (url: string) => {
        if (url.includes('/recko/')) return reckoFixture;
        if (url.includes('/turecko/')) throw new Error('network hiccup');
        return '<html><body>window.searchData = {"tourResults":[]};</body></html>';
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await fetchZajezdyOffers(ctx, new Date('2026-07-04T09:00:00Z'));

    expect(offers.length).toBe(30);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('turecko'));
  });

  it('stops fetching remaining slugs on SourceBlockedError but returns offers collected so far', async () => {
    const slugOrder = ['recko', 'turecko', 'egypt', 'chorvatsko', 'bulharsko', 'all-inclusive', 'letecky-praha'];
    const calledUrls: string[] = [];
    const http = {
      text: vi.fn(async (url: string) => {
        calledUrls.push(url);
        if (url.includes('/recko/')) return reckoFixture;
        if (url.includes('/turecko/')) throw new SourceBlockedError(403, 'blocked');
        throw new Error(`should not fetch ${url}`);
      }),
      json: vi.fn(),
    } as unknown as SourceContext['http'];

    const ctx = makeCtx(http);
    const offers = await fetchZajezdyOffers(ctx, new Date('2026-07-04T09:00:00Z'));

    expect(offers.length).toBe(30);
    // Only recko (success) and turecko (blocked, then stop) should have been requested.
    expect(calledUrls.length).toBe(2);
    void slugOrder;
  });
});
