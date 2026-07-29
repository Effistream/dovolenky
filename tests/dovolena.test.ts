import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseDovolena, buildQueries, dovolena } from '../src/sources/dovolena.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures/dovolena', name), 'utf-8'));

// Both fixtures are verbatim live captures (2026-07-29) of the query the adapter actually issues:
// perPage + length=8-8 pinned. The pre-fix fixture (no length filter, default perPage=10) no longer
// described any request this adapter makes.
const greeceFixture = load('tripListing.json'); // destination=4826, length=8-8, perPage=10
const zanzibarFixture = load('tripListing-zanzibar.json'); // destination=8814, length=8-8, perPage=3

const ADULTS = 2;
const queries = buildQueries(ADULTS);
const greeceQuery = queries.find((q) => q.url.includes('destination=4826&') && !q.url.includes('sortBy'))!;
const zanzibarQuery = queries.find((q) => q.url.includes('destination=8814&'))!;

const ctxWith = (json: ReturnType<typeof vi.fn>): SourceContext => ({
  http: { json, text: vi.fn() } as unknown as SourceContext['http'],
  adults: ADULTS,
  log: vi.fn(),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildQueries — request budget (spec: one bounded plan per run)', () => {
  it('stays inside the hard request cap and issues at most one base + one favourite slice per destination', () => {
    // MAX_REQUESTS = 24; the shipped plan is 21 (19 destinations + 2 favourite slices). The cap is
    // what stops a future destination row from silently pushing the adapter past run.ts's 240s abort.
    expect(queries.length).toBeLessThanOrEqual(24);
    expect(queries.length).toBe(21);

    const base = queries.filter((q) => !q.url.includes('sortBy='));
    const favourite = queries.filter((q) => q.url.includes('sortBy=favorite'));
    expect(base.length).toBe(19);
    expect(favourite.length).toBe(2);
    // Base slices first: if the site starts failing mid-run we keep breadth over band.
    expect(queries.slice(0, base.length).every((q) => !q.url.includes('sortBy='))).toBe(true);
    // No destination is queried twice within a slice.
    const destOf = (url: string) => new URL(url).searchParams.get('destination');
    expect(new Set(base.map((q) => destOf(q.url))).size).toBe(base.length);
    expect(new Set(favourite.map((q) => destOf(q.url))).size).toBe(favourite.length);
  });

  it('pins page size and trip length on every request, and derives nights from that length', () => {
    for (const q of queries) {
      const params = new URLSearchParams(new URL(q.url).search);
      expect(params.get('perPage')).toBe('20');
      expect(params.get('page')).toBe('1');
      expect(params.get('adult')).toBe(String(ADULTS));
      const [from, to] = params.get('length')!.split('-').map(Number) as [number, number];
      expect(from).toBe(to); // a range would make nights unknowable again
      expect(q.nights).toBe(from - 1); // "8 dní / 7 nocí" — the site's own wording
    }
    // Kuba is the one destination with no 8-day product (0 hotels at 8 days, 158 at 12).
    const kuba = queries.find((q) => q.url.includes('destination=4899&'))!;
    expect(kuba.url).toContain('length=12-12');
    expect(kuba.nights).toBe(11);
  });

  it('threads the configured party size into the query and the human URL', () => {
    const forThree = buildQueries(3);
    expect(forThree[0]!.url).toContain('adult=3');
    expect(forThree[0]!.humanUrlBase).toContain('adult=3');
  });
});

describe('parseDovolena (fixture, destination=4826 Řecko, length=8-8)', () => {
  const offers = parseDovolena(greeceFixture, greeceQuery, ADULTS);

  it('parses all 10 hotels from the response (no silent drops)', () => {
    expect(offers.length).toBe(10);
  });

  it('maps the first hotel (4 You Hotel Apartments) with hardcoded real values', () => {
    const first = offers[0]!;
    expect(first.source).toBe('dovolena');
    expect(first.title).toBe('4 You Hotel Apartments');
    expect(first.country).toBe('Řecko');
    expect(first.locality).toBe('Metamorfosis');
    expect(first.stars).toBe(3);
    expect(first.board).toBe('none');
    expect(first.transport).toBe('flight');
    expect(first.pricePerPerson).toBe(5339);
    expect(first.priceTotal).toBe(10678);
    expect(first.nights).toBe(7);
    expect(first.claimedOriginalPrice).toBeNull();
    expect(first.claimedDiscountPct).toBeNull();
    expect(first.departureDate).toBeNull();
    expect(first.sourceOfferKey).toBe('924338');
    // Human page, not the JSON endpoint: this URL renders "Dilino Hotel 2, Řecko, ..." style pages.
    expect(first.url).toBe('https://dovolena.cz/trip-detail?adult=2&destination=4826&length=8-8&hotelId=924338');
  });

  it('uses the deepest destination entry as locality, not the useless Greek "Ostrovy"/"Pevnina" split', () => {
    // destinations = Řecko > Ostrovy > Santorini > Kamari. Index 1 (the old behaviour) has exactly
    // two values across all 2778 Greek hotels, which collapses the locality discount rung.
    const dilino = offers.find((o) => o.sourceOfferKey === '924498')!;
    expect(dilino.title).toBe('Dilino Hotel');
    expect(dilino.locality).toBe('Kamari');
    expect(offers.map((o) => o.locality)).not.toContain('Ostrovy');
    expect(offers.map((o) => o.locality)).not.toContain('Pevnina');
    expect(new Set(offers.map((o) => o.locality)).size).toBeGreaterThan(2);
  });

  it('derives priceTotal from pricePerPerson x adults when the row omits priceInfo.group', () => {
    const stripped = {
      ...greeceFixture,
      hotels: greeceFixture.hotels.map((h: any) => ({ ...h, priceInfo: { regular: h.priceInfo.regular } })),
    };
    const derived = parseDovolena(stripped, greeceQuery, ADULTS);
    expect(derived[0]!.priceTotal).toBe(5339 * ADULTS);
    expect(derived.every((o) => o.priceTotal === o.pricePerPerson * ADULTS)).toBe(true);
    // Same identity the API itself uses wherever it does send `group`.
    expect(derived[0]!.priceTotal).toBe(offers[0]!.priceTotal);
  });

  it('enforces invariants: positive price, known nights, canonical-or-null country, clickable url', () => {
    for (const offer of offers) {
      expect(offer.pricePerPerson).toBeGreaterThan(0);
      expect(offer.priceTotal).toBeGreaterThan(0);
      expect(offer.source).toBe('dovolena');
      expect(offer.sourceOfferKey.length).toBeGreaterThan(0);
      expect(offer.country).toBe('Řecko');
      expect(offer.locality).not.toBe(offer.country);
      // nights is now known by construction from the pinned `length` — this is the whole point of
      // the filter: without it the API mixes 1-night and week-long prices in one price column.
      expect(offer.nights).toBe(7);
      expect(offer.url.startsWith('https://dovolena.cz/trip-detail?')).toBe(true);
      expect(offer.url).not.toContain('/api/');
      // Hotel-level rows still carry no departure day, and no claimed original price exists.
      expect(offer.departureDate).toBeNull();
      expect(offer.claimedOriginalPrice).toBeNull();
      expect(offer.claimedDiscountPct).toBeNull();
    }
  });

  it('dedupes hotels sharing the same hotelId', () => {
    const doubled = { ...greeceFixture, hotels: [...greeceFixture.hotels, greeceFixture.hotels[0]] };
    expect(parseDovolena(doubled, greeceQuery, ADULTS).length).toBe(offers.length);
  });

  it('returns [] for a response with no hotels array', () => {
    expect(parseDovolena({ hotels: [] }, greeceQuery, ADULTS)).toEqual([]);
    expect(parseDovolena({}, greeceQuery, ADULTS)).toEqual([]);
  });
});

describe('parseDovolena (fixture, destination=8814 Zanzibar)', () => {
  const offers = parseDovolena(zanzibarFixture, zanzibarQuery, ADULTS);

  it('falls back to the queried destination country when the site label is not canonical', () => {
    // The payload says "Zanzibar a Tanzanie", which isKnownCountry rejects — without the fallback
    // every Zanzibar row would land on the board with country=null.
    expect(zanzibarFixture.hotels[0].destinations[0].name).toBe('Zanzibar a Tanzanie');
    expect(offers.length).toBe(3);
    expect(offers.every((o) => o.country === 'Zanzibar')).toBe(true);
  });

  it('keeps the resort as locality and nulls it when the path stops at the country', () => {
    expect(offers[0]!.locality).toBe('Nungwi');
    expect(offers[1]!.locality).toBe('Matemwe Beach');
    // Kiwengwa Beach Resort's path is [Zanzibar a Tanzanie, Zanzibar]: the deepest entry only
    // repeats the country, which must not be published as a locality.
    expect(offers[2]!.locality).toBeNull();
  });
});

describe('dovolena source adapter', () => {
  it('is named dovolena and issues exactly the planned, capped number of requests', async () => {
    const jsonMock = vi.fn().mockResolvedValue(greeceFixture);
    const offers = await dovolena.fetchOffers(ctxWith(jsonMock));

    expect(dovolena.name).toBe('dovolena');
    expect(jsonMock.mock.calls.length).toBe(queries.length);
    expect(jsonMock.mock.calls.length).toBeLessThanOrEqual(24);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.source === 'dovolena')).toBe(true);
  });

  it('dedupes the same hotel appearing across several queries', async () => {
    const jsonMock = vi.fn().mockResolvedValue(greeceFixture);
    const offers = await dovolena.fetchOffers(ctxWith(jsonMock));
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
    // Same fixture for every query -> only the first query's 10 hotels survive.
    expect(offers.length).toBe(10);
  });

  it('stops issuing new requests once the soft deadline passes, keeping what it has', async () => {
    vi.useFakeTimers();
    // Every response "costs" 60s of wall clock; the soft deadline must cut the plan short well
    // before run.ts's 240s abort would throw the whole source away.
    const jsonMock = vi.fn().mockImplementation(async () => {
      vi.advanceTimersByTime(60_000);
      return greeceFixture;
    });

    const offers = await dovolena.fetchOffers(ctxWith(jsonMock));
    expect(jsonMock.mock.calls.length).toBe(3); // 0s, 60s, 120s issued; 180s > deadline stops it
    expect(jsonMock.mock.calls.length).toBeLessThan(queries.length);
    expect(offers.length).toBe(10);
  });

  it('returns before run.ts aborts even when EVERY request costs the HttpClient worst case', async () => {
    vi.useFakeTimers();
    // The property the soft deadline actually has to guarantee. run.ts aborts at 240s and throws
    // away everything the adapter had collected, so `soft deadline + one in-flight request` must
    // stay under 240s. One http.json() worst case is NOT 25s: that is the per-ATTEMPT ceiling, and
    // src/core/http.ts does 3s host gap + MAX_ATTEMPTS(3) x REQUEST_TIMEOUT_MS(25s) +
    // RETRY_BACKOFF_MS(500 + 2000) ~= 80.5s. A 175s deadline lets a request issued at 174.9s
    // settle at ~255s — past the abort, in exactly the slow-host case the deadline exists for.
    const WORST_CASE_REQUEST_MS = 80_500;
    const ADAPTER_FETCH_TIMEOUT_MS = 240_000; // src/core/run.ts

    const startedAt = Date.now();
    const jsonMock = vi.fn().mockImplementation(async () => {
      vi.advanceTimersByTime(WORST_CASE_REQUEST_MS);
      return greeceFixture;
    });

    const offers = await dovolena.fetchOffers(ctxWith(jsonMock));
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(ADAPTER_FETCH_TIMEOUT_MS);
    expect(jsonMock.mock.calls.length).toBeGreaterThan(0);
    expect(offers.length).toBe(10); // partial coverage returned, not thrown away
  });

  it('isolates a per-query request failure without sinking the whole fetch', async () => {
    const jsonMock = vi.fn().mockRejectedValueOnce(new Error('network blip')).mockResolvedValue(greeceFixture);
    const offers = await dovolena.fetchOffers(ctxWith(jsonMock));
    expect(offers.length).toBeGreaterThan(0);
    expect(jsonMock.mock.calls.length).toBe(queries.length);
  });

  it('stops issuing further requests on SourceBlockedError but keeps offers already collected', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce(greeceFixture)
      .mockRejectedValueOnce(new SourceBlockedError(403, 'blocked'));

    const offers = await dovolena.fetchOffers(ctxWith(jsonMock));
    expect(offers.length).toBeGreaterThan(0);
    expect(jsonMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the FIRST query is blocked before any success (backoff must engage)', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    const jsonMock = vi.fn().mockRejectedValue(new SourceBlockedError(403, 'blocked'));
    await expect(dovolena.fetchOffers(ctxWith(jsonMock))).rejects.toThrow('blocked');
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('rethrows when every query fails (runScan must record failed, not an empty source)', async () => {
    const jsonMock = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(dovolena.fetchOffers(ctxWith(jsonMock))).rejects.toThrow('boom');
    expect(jsonMock.mock.calls.length).toBe(queries.length);
  });
});
