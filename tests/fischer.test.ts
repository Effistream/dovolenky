import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseFischerHydration,
  mapFischerSearchCards,
  selectDiverseTours,
  fischer,
} from '../src/sources/fischer.js';
import type { NormalizedOffer, SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/fischer', name), 'utf-8');
const lastMinuteHtml = fixture('last-minute.html');
// A real /searchresult/getsearch response (captured 2026-07-29, Řecko/Kos 2026-07-31, 4 nights),
// trimmed to its first 3 hotel cards so the fixture stays reviewable.
const getsearchFixture = JSON.parse(fixture('getsearch.json')) as { HTML: string };
// A real POST /api/TourList/getTourList page-2 response (searchFromIndex 20).
const getTourListFixture = JSON.parse(fixture('getTourList.json')) as { tours: unknown[]; totalCount: number };

const KOS_TOUR_META = {
  departureDate: '2026-07-31',
  nights: 4,
  country: 'Řecko',
  locality: 'Kos',
  departureLocation: 'Praha',
};

describe('parseFischerHydration', () => {
  const { documentGuid, tours, totalCount } = parseFischerHydration(lastMinuteHtml);

  it('extracts a documentGuid', () => {
    expect(documentGuid).toBe('04af28e1-df72-4dc0-894e-6548566d67dc');
  });

  it('extracts the embedded tours and the real corpus size behind them', () => {
    // The page embeds only the first 20 tours but states how many exist — that number is what
    // makes paging possible (and what proved the old adapter was scanning 10 of 200).
    expect(tours.length).toBe(20);
    expect(totalCount).toBe(200);
    expect(totalCount).toBeGreaterThan(tours.length);
  });

  it('the first tour carries real hydration values', () => {
    const first = tours[0] as {
      id: number;
      searchFilter: string;
      departureDate: string;
      location: { country: string; destination: string };
      departureLocation: string;
      nightsCount: { from: number; to: number };
      adultPriceFrom: { amount: number };
    };
    expect(first.id).toBe(1153223605);
    expect(first.searchFilter).toBe(
      'DS=0&TT=1&TO=4312&D=63242&DD=2026-07-31&RD=2026-08-11&ER=0&ISSS=0&NN=11&PF=0&AC1=2&KC1=0&IC1=0&QF=109_1_0&ILM=1',
    );
    expect(first.departureDate).toBe('2026-07-31T00:00:00');
    expect(first.location.country).toBe('Španělsko');
    expect(first.location.destination).toBe('Costa Brava');
    expect(first.departureLocation).toBe('Praha');
    expect(first.nightsCount).toEqual({ from: 11, to: 11 });
    expect(first.adultPriceFrom.amount).toBe(29990);
  });

  it('returns empty (not a throw) when the hydration blob is missing', () => {
    expect(parseFischerHydration('<html><body>nope</body></html>')).toEqual({
      documentGuid: '',
      tours: [],
      totalCount: 0,
    });
  });
});

describe('mapFischerSearchCards (fixture)', () => {
  const offers = mapFischerSearchCards(getsearchFixture.HTML, KOS_TOUR_META);

  it('maps every card in the fixture (no silent drops)', () => {
    expect(offers.length).toBe(3);
  });

  it('maps the first card (MITSIS NORIDA) with hardcoded real values', () => {
    const first = offers[0]!;
    expect(first.source).toBe('fischer');
    expect(first.title).toBe('MITSIS NORIDA');
    expect(first.stars).toBe(5);
    expect(first.board).toBe('AI'); // All Inclusive Ultra
    expect(first.pricePerPerson).toBe(25990);
    expect(first.priceTotal).toBe(51980); // party total, 2 adults
    expect(first.nights).toBe(4); // the card's printed "4 nocí/5 dní (Pá-Út)" term line
    expect(first.departureDate).toBe('2026-07-31');
    expect(first.departureAirport).toBe('Praha'); // gtm dimension14 "Flight-Praha"
    expect(first.country).toBe('Řecko');
    expect(first.locality).toBe('Kos');
    expect(first.transport).toBe('flight');
    expect(first.url).toBe(
      'https://www.fischer.cz/recko/kos/kardamena/mitsis-norida-beach?DS=256&GIATA=706&D=63319&HID=2630&PF=0&MT=5&DI=AU&RCS=DR02&NN=4&MNN=4&NNM=4&DF=2026-07-31%7C2026-08-04&RD=2026-08-04&DD=2026-07-31&ERM=0&AC1=2&KC1=0&IC1=0&TO=4312&TT=1&PID=KGS20020&DPR=FISCHER+ATCOM&ILM=1&PC=15771691%2F2%2F2403%2F4&IFC=135518825%2F471653&OFC=135554912%2F471926',
    );
    expect(first.omnibusLowestPrice).toBeNull();
    expect(first.tourOperator).toBeNull();
  });

  it('maps the crossed-out price and discount the site prints, converted to per person', () => {
    // Card 1 prints "Původní cena 76 000 Kč" / "Sleva 24 020 Kč" against a 51 980 Kč party total
    // for 2 adults → 38 000 per person original, 25 990 paid, 32 % off.
    const first = offers[0]!;
    expect(first.claimedOriginalPrice).toBe(38000);
    expect(first.claimedDiscountPct).toBe(32);
    // Every card in this fixture carries a discount — the field is no longer structurally null.
    expect(offers.every((o) => o.claimedOriginalPrice !== null && o.claimedDiscountPct !== null)).toBe(true);
    for (const o of offers) {
      expect(o.claimedOriginalPrice!).toBeGreaterThan(o.pricePerPerson);
      expect(o.claimedDiscountPct!).toBeGreaterThan(0);
      expect(o.claimedDiscountPct!).toBeLessThan(100);
    }
  });

  it('maps meal -> board and the real star rating across the fixture', () => {
    const byName = new Map(offers.map((o) => [o.title, o]));
    expect(byName.get('White Olive Marine Aquapark')!.board).toBe('AI'); // All Inclusive
    expect(byName.get('Kos City Sunstone')!.board).toBe('BB'); // Snídaně
    // gtm dimension6 is 5 on every card; the real rating is the asterisk run in .js-stars.
    expect(byName.get('White Olive Marine Aquapark')!.stars).toBe(4);
    expect(byName.get('Kos City Sunstone')!.stars).toBe(3);
  });

  it('enforces invariants: positive price, absolute fischer.cz url, correct source tag', () => {
    for (const offer of offers) {
      expect(offer.pricePerPerson).toBeGreaterThan(0);
      expect(offer.url.startsWith('https://www.fischer.cz')).toBe(true);
      expect(offer.url).not.toContain('#');
      expect(offer.source).toBe('fischer');
      expect(offer.sourceOfferKey.length).toBeGreaterThan(0);
    }
  });

  it('produces a canonical country or null, never a locality/city value', () => {
    for (const offer of offers) {
      expect(offer.country === null || typeof offer.country === 'string').toBe(true);
      if (offer.country !== null) expect(offer.country).not.toBe(offer.locality);
    }
  });

  it('falls back to null country for an unrecognized/garbled location', () => {
    const offers2 = mapFischerSearchCards(getsearchFixture.HTML, {
      ...KOS_TOUR_META,
      country: 'Nesmyslná Zeme Xyz',
      locality: 'Nekde',
    });
    expect(offers2[0]!.country).toBeNull();
  });

  it('dedupes cards sharing the same hotel/date/nights/board/airport key', () => {
    const doubled = getsearchFixture.HTML + getsearchFixture.HTML;
    expect(mapFischerSearchCards(doubled, KOS_TOUR_META).length).toBe(offers.length);
  });
});

/** Minimal synthetic card carrying just the attributes the mapper reads. */
function buildCard(opts: {
  name: string;
  id?: number;
  adultPrice?: number;
  total?: number;
  departure?: string;
  meal?: string;
  stars?: string;
  start?: string;
  end?: string;
  priceRows?: string;
  href?: string;
  term?: string;
}): string {
  const gtm = JSON.stringify({
    name: opts.name,
    id: String(opts.id ?? 1),
    price: opts.total ?? 20000,
    dimension2: 'Řecko',
    dimension3: 'Kos',
    dimension4: opts.adultPrice ?? 10000,
    dimension14: opts.departure ?? 'Flight-Praha',
    dimension15: opts.meal ?? 'All Inclusive',
  }).replace(/"/g, '&quot;');
  return `<div id="divHotelCard" data-start-date="${opts.start ?? '2026-07-31'}" data-end-date="${
    opts.end ?? '2026-08-04'
  }">
    <div class="js-gtm-product-item" data-gtm-impression="${gtm}">
      <h2><a href="${opts.href ?? '/recko/kos/hotel-x?HID=1'}">${opts.name}</a></h2>
      <span class="js-stars">${opts.stars ?? '****'}</span>
      ${
        opts.term
          ? `<div class="fshr-detail-summary-mainInfo"><p class="fshr-detail-summary-title">4. 8. 2026 - 19. 8. 2026</p><p class="fshr-detail-summary-paragraph">${opts.term}</p></div>`
          : ''
      }
      ${opts.priceRows ?? ''}
    </div>
  </div>`;
}

describe('mapFischerSearchCards (edge cases)', () => {
  it('leaves the claimed-discount fields null when the card prints no discount row', () => {
    const offers = mapFischerSearchCards(buildCard({ name: 'No Deal Hotel' }), KOS_TOUR_META);
    expect(offers.length).toBe(1);
    expect(offers[0]!.claimedOriginalPrice).toBeNull();
    expect(offers[0]!.claimedDiscountPct).toBeNull();
  });

  it('rejects a nonsensical discount (original not above the paid price) rather than guessing', () => {
    const rows =
      '<td class="js-roomPrice-originalPrice">18 000 Kč</td><td class="js-roomPrice-discount">2 000 Kč</td>';
    const offers = mapFischerSearchCards(
      buildCard({ name: 'Odd Hotel', adultPrice: 10000, total: 20000, priceRows: rows }),
      KOS_TOUR_META,
    );
    expect(offers[0]!.claimedOriginalPrice).toBeNull();
    expect(offers[0]!.claimedDiscountPct).toBeNull();
  });

  it('normalizes an unrated property (empty stars span) to null, never 0', () => {
    const offers = mapFischerSearchCards(buildCard({ name: 'Villa Dio', stars: '' }), KOS_TOUR_META);
    expect(offers[0]!.stars).toBeNull();
  });

  it('takes nights from the card term, not from the tour summary', () => {
    // Tour meta says 4 nights; this card's own term is 11 — the card wins.
    const offers = mapFischerSearchCards(
      buildCard({ name: 'Long Stay', start: '2026-07-31', end: '2026-08-11' }),
      KOS_TOUR_META,
    );
    expect(offers[0]!.nights).toBe(11);
  });

  it('prefers the printed "N nocí" over the date span when the two disagree', () => {
    // Live case (Kos, 2026-08-04 → 2026-08-19): a 15-day window sold as 14 nights because the
    // return flight is at night. Counting days would overstate the stay by one on every such term.
    const html = buildCard({
      name: 'Night Flight Hotel',
      start: '2026-08-04',
      end: '2026-08-19',
      term: '14 nocí/15 dní (Út-St)',
    });
    expect(mapFischerSearchCards(html, KOS_TOUR_META)[0]!.nights).toBe(14);
  });

  it('keeps two identical hotels apart when only the departure city differs', () => {
    // Live regression: the same hotel/date/nights/board is sold as separate Praha and Ostrava
    // tours; before departureAirport joined the key they collapsed into one offer.
    const html =
      buildCard({ name: 'Same Hotel', id: 42, departure: 'Flight-Praha' }) +
      buildCard({ name: 'Same Hotel', id: 42, departure: 'Flight-Ostrava' });
    const offers = mapFischerSearchCards(html, KOS_TOUR_META);
    expect(offers.length).toBe(2);
    expect(offers.map((o) => o.departureAirport).sort()).toEqual(['Ostrava', 'Praha']);
    expect(offers[0]!.sourceOfferKey).not.toBe(offers[1]!.sourceOfferKey);
  });

  it('falls back to the tour departure city when the card carries no gtm transport dimension', () => {
    const offers = mapFischerSearchCards(buildCard({ name: 'X', departure: 'Flight' }), {
      ...KOS_TOUR_META,
      departureLocation: 'Brno',
    });
    expect(offers[0]!.departureAirport).toBe('Brno');
  });

  it('falls back to the tour date when the card carries an empty data-start-date', () => {
    // `?? null` would have kept the empty string and emitted departureDate: '' — a malformed value
    // that still passes a `!== null` check downstream.
    const offers = mapFischerSearchCards(buildCard({ name: 'No Date', start: '' }), KOS_TOUR_META);
    expect(offers[0]!.departureDate).toBe('2026-07-31');
  });

  it('falls back to the tour departure city when dimension14 has a separator but no city', () => {
    const offers = mapFischerSearchCards(buildCard({ name: 'Y', departure: 'Flight-' }), {
      ...KOS_TOUR_META,
      departureLocation: 'Ostrava',
    });
    expect(offers[0]!.departureAirport).toBe('Ostrava');
  });

  it('skips a card with no usable price instead of emitting a zero-price offer', () => {
    const html = buildCard({ name: 'Free Hotel', adultPrice: 0 });
    expect(mapFischerSearchCards(html, KOS_TOUR_META).length).toBe(0);
  });
});

function makeTour(overrides: Record<string, unknown>) {
  return {
    id: 1,
    searchFilter: 'DS=0&TT=1',
    departureDate: '2026-07-31T00:00:00',
    location: { country: 'Řecko', destination: 'Kos' },
    departureLocation: 'Praha',
    nightsCount: { from: 7, to: 7 },
    adultPriceFrom: { amount: 10000 },
    ...overrides,
  } as never;
}

describe('selectDiverseTours', () => {
  it('returns everything (sorted, earliest departure first) when the corpus fits the limit', () => {
    const tours = [
      makeTour({ id: 2, departureDate: '2026-08-05T00:00:00' }),
      makeTour({ id: 1, departureDate: '2026-07-31T00:00:00' }),
    ];
    expect(selectDiverseTours(tours, 10).map((t) => t.id)).toEqual([1, 2]);
  });

  it('covers every country before repeating one', () => {
    // 4 Greek tours crowd the front of the list; a naive "earliest departures" pick would take
    // only those. The selection must reach Egypt/Španělsko/Bulharsko first.
    const tours = [
      ...[1, 2, 3, 4].map((i) =>
        makeTour({ id: i, location: { country: 'Řecko', destination: `Kos${i}` }, departureDate: '2026-07-29T00:00:00' }),
      ),
      makeTour({ id: 5, location: { country: 'Egypt', destination: 'Hurghada' }, departureDate: '2026-08-10T00:00:00' }),
      makeTour({ id: 6, location: { country: 'Španělsko', destination: 'Mallorca' }, departureDate: '2026-08-11T00:00:00' }),
      makeTour({ id: 7, location: { country: 'Bulharsko', destination: 'Burgas' }, departureDate: '2026-08-12T00:00:00' }),
    ];
    const picked = selectDiverseTours(tours, 4);
    expect(new Set(picked.map((t) => t.location.country))).toEqual(
      new Set(['Řecko', 'Egypt', 'Španělsko', 'Bulharsko']),
    );
  });

  it('reaches the expensive / long-stay tail the old earliest-first pick never requested', () => {
    const cheapCrowd = Array.from({ length: 20 }, (_, i) =>
      makeTour({
        id: i + 1,
        departureDate: '2026-07-31T00:00:00',
        location: { country: 'Řecko', destination: 'Kos' },
        nightsCount: { from: 7, to: 7 },
        adultPriceFrom: { amount: 12000 },
      }),
    );
    const luxury = makeTour({
      id: 99,
      departureDate: '2026-08-14T00:00:00',
      location: { country: 'Řecko', destination: 'Paxos' },
      nightsCount: { from: 14, to: 14 },
      adultPriceFrom: { amount: 193150 },
    });
    const picked = selectDiverseTours([...cheapCrowd, luxury], 3);
    expect(picked.map((t) => t.id)).toContain(99);
  });

  it('is deterministic and never exceeds the limit', () => {
    const tours = getTourListFixture.tours as never[];
    const a = selectDiverseTours(tours, 7);
    const b = selectDiverseTours(tours, 7);
    expect(a.length).toBe(7);
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
  });

  it('spreads across every facet on the real paged fixture', () => {
    // Page 2 holds Řecko ×10, Španělsko ×9 and a single Kapverdské ostrovy tour; nights run
    // 7/10/11/14. Five picks must reach all three countries — including the one-off Kapverdy tour
    // that an earliest-departure pick would never see — and more than one length of stay.
    const tours = getTourListFixture.tours as never[];
    const picked = selectDiverseTours(tours, 5);
    expect(new Set(picked.map((t) => t.location.country))).toEqual(
      new Set(['Řecko', 'Španělsko', 'Kapverdské ostrovy']),
    );
    expect(new Set(picked.map((t) => t.nightsCount?.from)).size).toBeGreaterThanOrEqual(3);
  });

  it('returns nothing for a zero/negative limit', () => {
    expect(selectDiverseTours([makeTour({})], 0)).toEqual([]);
  });
});

/** http mock that dispatches on URL, so one ctx serves all three endpoints. */
function makeCtx(opts: {
  page?: () => Promise<string>;
  tourList?: (index: number) => Promise<unknown>;
  getsearch?: (searchFilter: string) => Promise<unknown>;
}) {
  const calls: string[] = [];
  const text = vi.fn(async (url: string) => {
    calls.push(url);
    return opts.page ? await opts.page() : lastMinuteHtml;
  });
  const json = vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push(url);
    if (url.includes('/api/TourList/getTourList')) {
      const index = init?.body ? (JSON.parse(init.body).searchSettings.searchFromIndex as number) : 0;
      return opts.tourList ? await opts.tourList(index) : { tours: [], totalCount: 200 };
    }
    const searchFilter = url.split('?')[1] ?? '';
    return opts.getsearch ? await opts.getsearch(searchFilter) : getsearchFixture;
  });
  const ctx: SourceContext = {
    http: { json, text } as unknown as SourceContext['http'],
    adults: 2,
    log: vi.fn(),
  };
  return { ctx, calls, text, json };
}

describe('fischer source adapter (fixture-backed)', () => {
  it('pages the tour list and then fetches details, staying inside the hard request budget', async () => {
    const { ctx, calls, text, json } = makeCtx({
      tourList: async () => getTourListFixture,
    });

    const offers = await fischer.fetchOffers(ctx);

    expect(fischer.name).toBe('fischer');
    expect(text).toHaveBeenCalledTimes(1); // the /last-minute page, once
    const listCalls = calls.filter((u) => u.includes('getTourList'));
    const detailCalls = calls.filter((u) => u.includes('/searchresult/getsearch'));
    // Budget contract (MAX_REQUESTS 35 = 1 page + ≤9 list pages + ≤25 details). A site change must
    // not be able to grow this: 40 requests × ~4s would blow ADAPTER_FETCH_TIMEOUT_MS.
    expect(calls.length).toBeLessThanOrEqual(35);
    expect(listCalls.length).toBeLessThanOrEqual(9);
    expect(detailCalls.length).toBeLessThanOrEqual(25);
    expect(detailCalls.length).toBeGreaterThan(10);
    expect(json.mock.calls.length).toBe(listCalls.length + detailCalls.length);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.source === 'fischer')).toBe(true);
  });

  it('requests successive getTourList offsets and actually uses the paged tours', async () => {
    const offsets: number[] = [];
    // Page 2+ carries a tour whose destination exists nowhere in the embedded 20 — if the adapter
    // ever stops paging, this offer disappears.
    const { ctx } = makeCtx({
      tourList: async (index) => {
        offsets.push(index);
        return getTourListFixture;
      },
      getsearch: async (searchFilter) => ({
        HTML: buildCard({ name: `H-${searchFilter.slice(0, 12)}`, href: `/x?${searchFilter.slice(0, 12)}` }),
        groupData: { ProductsCount: 1 },
      }),
    });

    await fischer.fetchOffers(ctx);

    expect(offsets).toEqual([20, 40, 60, 80, 100, 120, 140, 160, 180]);
  });

  it('caps details even when the site starts advertising far more tours', async () => {
    const many = { tours: Array.from({ length: 20 }, (_, i) => makeTour({ id: 1000 + i })), totalCount: 100000 };
    const { ctx, calls } = makeCtx({ tourList: async () => many });

    await fischer.fetchOffers(ctx);

    expect(calls.filter((u) => u.includes('getTourList')).length).toBe(9);
    expect(calls.filter((u) => u.includes('/searchresult/getsearch')).length).toBe(25);
    expect(calls.length).toBe(35);
  });

  it('isolates a per-tour detail failure without sinking the whole fetch', async () => {
    let n = 0;
    const { ctx } = makeCtx({
      tourList: async () => getTourListFixture,
      getsearch: async () => {
        n += 1;
        if (n === 1) throw new Error('network blip');
        return getsearchFixture;
      },
    });

    const offers = await fischer.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
  });

  it('survives a getTourList page failure by falling back to the embedded tours', async () => {
    const { ctx, calls } = makeCtx({
      tourList: async () => {
        throw new Error('list 500');
      },
    });

    const offers = await fischer.fetchOffers(ctx);
    expect(calls.filter((u) => u.includes('getTourList')).length).toBe(1); // stops paging, doesn't retry
    expect(offers.length).toBeGreaterThan(0);
  });

  it('rethrows when EVERY detail request fails (not "market empty")', async () => {
    // Degrading to [] here would flip the source's whole inventory inactive after 2 runs and mute
    // the 3x-failed health alert — the seed fetch succeeded, so silence is the wrong signal.
    const { ctx, calls } = makeCtx({
      tourList: async () => getTourListFixture,
      getsearch: async () => {
        throw new Error('detail 500');
      },
    });

    await expect(fischer.fetchOffers(ctx)).rejects.toThrow('detail 500');
    // Non-blocking errors keep going (unlike a block), so the full detail budget is spent.
    expect(calls.filter((u) => u.includes('/searchresult/getsearch')).length).toBe(25);
    expect(calls.length).toBe(35);
  });

  it('rethrows a total last-minute page fetch failure (so runScan records it failed, not empty)', async () => {
    const { ctx, json } = makeCtx({
      page: async () => {
        throw new Error('page down');
      },
    });

    await expect(fischer.fetchOffers(ctx)).rejects.toThrow('page down');
    expect(json).not.toHaveBeenCalled();
  });

  it('stops on SourceBlockedError but keeps offers already collected', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    let n = 0;
    const { ctx, calls } = makeCtx({
      tourList: async () => getTourListFixture,
      getsearch: async () => {
        n += 1;
        if (n === 1) return getsearchFixture;
        throw new SourceBlockedError(403, 'blocked');
      },
    });

    const offers = await fischer.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    // 1 page + 9 list pages + 2 details (the second one blocked) and then nothing more.
    expect(calls.filter((u) => u.includes('/searchresult/getsearch')).length).toBe(2);
  });

  it('rethrows when the FIRST detail request is blocked before any success (backoff must engage)', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    const { ctx, calls } = makeCtx({
      tourList: async () => getTourListFixture,
      getsearch: async () => {
        throw new SourceBlockedError(403, 'blocked');
      },
    });

    await expect(fischer.fetchOffers(ctx)).rejects.toThrow('blocked');
    expect(calls.filter((u) => u.includes('/searchresult/getsearch')).length).toBe(1);
  });

  it('rethrows a block during paging without issuing any detail request', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    const { ctx, calls } = makeCtx({
      tourList: async () => {
        throw new SourceBlockedError(429, 'blocked while paging');
      },
    });

    await expect(fischer.fetchOffers(ctx)).rejects.toThrow('blocked while paging');
    expect(calls.filter((u) => u.includes('/searchresult/getsearch')).length).toBe(0);
  });

  it('emits a wider board than the tour teaser suggests (countries, dates, price band)', async () => {
    // End-to-end shape check on fixtures: distinct tours must survive into distinct offers with
    // real per-person prices and departure cities filled in.
    const { ctx } = makeCtx({ tourList: async () => getTourListFixture });
    const offers: NormalizedOffer[] = await fischer.fetchOffers(ctx);

    expect(offers.every((o) => o.departureAirport !== null)).toBe(true);
    expect(offers.every((o) => o.priceTotal !== null && o.priceTotal >= o.pricePerPerson)).toBe(true);
    expect(offers.filter((o) => o.claimedDiscountPct !== null).length).toBeGreaterThan(0);
    expect(new Set(offers.map((o) => o.sourceOfferKey)).size).toBe(offers.length);
  });
});
