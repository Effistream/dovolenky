import { describe, it, expect } from 'vitest';
import {
  emptyFilterState,
  isDefaultState,
  activeFilterCount,
  nightsInBand,
  matchesCountry,
  matchesMaxPrice,
  matchesNights,
  matchesBoard,
  matchesDeparture,
  isOwnTransport,
  matchesDateRange,
  matchesMinRealPct,
  matchesSource,
  applyFilters,
  sortBy,
  applyFilterAndSort,
  countryFacets,
  airportFacets,
  sourceFacets,
  boardFacets,
  hasOwnTransport,
  serializeFilterState,
  serializeFilterQuery,
  parseFilterState,
  type FilterState,
} from './filters.js';
import type { Offer } from './types.js';

function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: 1,
    source: 'invia',
    title: 'Hotel',
    country: 'Řecko',
    locality: 'Kréta',
    stars: 4,
    board: 'AI',
    transport: 'flight',
    departureAirport: 'PRG',
    departureDate: '2026-08-15',
    nights: 7,
    pricePerPerson: 12000,
    priceTotal: 24000,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    tourOperator: null,
    url: 'https://x/1',
    realPct: 20,
    reference: 'market',
    baseline: 15000,
    fake: false,
    alternatives: [],
    sparkline: [],
    ...over,
  };
}

function state(over: Partial<FilterState> = {}): FilterState {
  return { ...emptyFilterState(), ...over };
}

// ---------------------------------------------------------------------------
// State bookkeeping
// ---------------------------------------------------------------------------

describe('emptyFilterState / isDefaultState / activeFilterCount', () => {
  it('empty state is default with zero active filters', () => {
    const s = emptyFilterState();
    expect(isDefaultState(s)).toBe(true);
    expect(activeFilterCount(s)).toBe(0);
  });
  it('a non-default sort alone is not counted as a filter but is not default', () => {
    const s = state({ sort: 'price' });
    expect(activeFilterCount(s)).toBe(0);
    expect(isDefaultState(s)).toBe(false);
  });
  it('counts each active dimension once; airports+own collapse to one', () => {
    expect(activeFilterCount(state({ countries: ['Řecko'] }))).toBe(1);
    expect(activeFilterCount(state({ maxPrice: 20000 }))).toBe(1);
    expect(activeFilterCount(state({ nights: ['6-8'] }))).toBe(1);
    expect(activeFilterCount(state({ boards: ['AI'] }))).toBe(1);
    expect(activeFilterCount(state({ airports: ['PRG'], ownTransport: true }))).toBe(1);
    expect(activeFilterCount(state({ dateFrom: '2026-01-01', dateTo: '2026-12-31' }))).toBe(1);
    expect(activeFilterCount(state({ minRealPct: 15 }))).toBe(1);
    expect(activeFilterCount(state({ sources: ['invia'] }))).toBe(1);
  });
  it('a 0 % minRealPct is a no-op: not counted as active', () => {
    expect(activeFilterCount(state({ minRealPct: 0 }))).toBe(0);
  });
  it('sums across dimensions', () => {
    const s = state({ countries: ['Řecko'], nights: ['6-8'], minRealPct: 15 });
    expect(activeFilterCount(s)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// nightsInBand
// ---------------------------------------------------------------------------

describe('nightsInBand', () => {
  it('classifies each boundary', () => {
    expect(nightsInBand(5, 'le5')).toBe(true);
    expect(nightsInBand(6, 'le5')).toBe(false);
    expect(nightsInBand(6, '6-8')).toBe(true);
    expect(nightsInBand(8, '6-8')).toBe(true);
    expect(nightsInBand(9, '6-8')).toBe(false);
    expect(nightsInBand(12, '9-12')).toBe(true);
    expect(nightsInBand(13, '9-12')).toBe(false);
    expect(nightsInBand(13, '13+')).toBe(true);
    expect(nightsInBand(30, '13+')).toBe(true);
  });
  it('null / non-finite nights never match', () => {
    expect(nightsInBand(null, 'le5')).toBe(false);
    expect(nightsInBand(Number.NaN, '13+')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Predicates — each pass-all on empty, then positive/negative
// ---------------------------------------------------------------------------

describe('matchesCountry', () => {
  it('empty selection passes all', () => {
    expect(matchesCountry(offer({ country: 'Řecko' }), [])).toBe(true);
    expect(matchesCountry(offer({ country: null }), [])).toBe(true);
  });
  it('keeps only listed countries; null country never matches', () => {
    expect(matchesCountry(offer({ country: 'Řecko' }), ['Řecko'])).toBe(true);
    expect(matchesCountry(offer({ country: 'Turecko' }), ['Řecko'])).toBe(false);
    expect(matchesCountry(offer({ country: null }), ['Řecko'])).toBe(false);
  });
});

describe('matchesMaxPrice', () => {
  it('null ceiling passes all', () => {
    expect(matchesMaxPrice(offer({ pricePerPerson: 99999 }), null)).toBe(true);
  });
  it('inclusive at the ceiling', () => {
    expect(matchesMaxPrice(offer({ pricePerPerson: 20000 }), 20000)).toBe(true);
    expect(matchesMaxPrice(offer({ pricePerPerson: 20001 }), 20000)).toBe(false);
    expect(matchesMaxPrice(offer({ pricePerPerson: 15000 }), 20000)).toBe(true);
  });
});

describe('matchesNights', () => {
  it('empty passes all', () => {
    expect(matchesNights(offer({ nights: 7 }), [])).toBe(true);
  });
  it('ORs bands', () => {
    expect(matchesNights(offer({ nights: 7 }), ['6-8'])).toBe(true);
    expect(matchesNights(offer({ nights: 4 }), ['6-8'])).toBe(false);
    expect(matchesNights(offer({ nights: 4 }), ['le5', '13+'])).toBe(true);
  });
  it('null nights fail any active band', () => {
    expect(matchesNights(offer({ nights: null }), ['le5', '6-8', '9-12', '13+'])).toBe(false);
  });
});

describe('matchesBoard', () => {
  it('empty passes all; else exact code membership', () => {
    expect(matchesBoard(offer({ board: 'AI' }), [])).toBe(true);
    expect(matchesBoard(offer({ board: 'AI' }), ['AI', 'HB'])).toBe(true);
    expect(matchesBoard(offer({ board: 'BB' }), ['AI', 'HB'])).toBe(false);
    expect(matchesBoard(offer({ board: 'none' }), ['none'])).toBe(true);
  });
  it('FB (plná penze) is a first-class board code, matchable like any other', () => {
    expect(matchesBoard(offer({ board: 'FB' }), ['FB'])).toBe(true);
    expect(matchesBoard(offer({ board: 'FB' }), ['AI', 'HB'])).toBe(false);
    expect(matchesBoard(offer({ board: 'AI' }), ['FB'])).toBe(false);
  });
  it('unknown board offers are filterable via the "unknown" code', () => {
    expect(matchesBoard(offer({ board: 'unknown' }), ['unknown'])).toBe(true);
    expect(matchesBoard(offer({ board: 'unknown' }), ['AI'])).toBe(false);
  });
});

describe('isOwnTransport / matchesDeparture', () => {
  it('own-transport = no airport and non-flight transport', () => {
    expect(isOwnTransport(offer({ departureAirport: null, transport: 'own' }))).toBe(true);
    expect(isOwnTransport(offer({ departureAirport: '', transport: 'bus' }))).toBe(true);
    expect(isOwnTransport(offer({ departureAirport: 'PRG', transport: 'flight' }))).toBe(false);
    // A flight with no airport is not "own transport".
    expect(isOwnTransport(offer({ departureAirport: null, transport: 'flight' }))).toBe(false);
  });
  it('empty airports + own off passes all', () => {
    expect(matchesDeparture(offer(), [], false)).toBe(true);
  });
  it('matches an airport code (case-insensitive)', () => {
    expect(matchesDeparture(offer({ departureAirport: 'PRG' }), ['PRG'], false)).toBe(true);
    expect(matchesDeparture(offer({ departureAirport: 'brq' }), ['BRQ'], false)).toBe(true);
    expect(matchesDeparture(offer({ departureAirport: 'OSR' }), ['PRG'], false)).toBe(false);
  });
  it('own toggle ORs with airport list', () => {
    const own = offer({ departureAirport: null, transport: 'own' });
    expect(matchesDeparture(own, ['PRG'], false)).toBe(false);
    expect(matchesDeparture(own, ['PRG'], true)).toBe(true);
    // A PRG flight still passes when own is on (OR).
    expect(matchesDeparture(offer({ departureAirport: 'PRG' }), [], true)).toBe(false);
    expect(matchesDeparture(offer({ departureAirport: 'PRG' }), ['PRG'], true)).toBe(true);
  });
});

describe('matchesDateRange', () => {
  it('no bounds passes all', () => {
    expect(matchesDateRange(offer(), null, null)).toBe(true);
  });
  it('inclusive from/to, lexicographic on ISO dates', () => {
    const o = offer({ departureDate: '2026-08-15' });
    expect(matchesDateRange(o, '2026-08-01', '2026-08-31')).toBe(true);
    expect(matchesDateRange(o, '2026-08-15', '2026-08-15')).toBe(true);
    expect(matchesDateRange(o, '2026-08-16', null)).toBe(false);
    expect(matchesDateRange(o, null, '2026-08-14')).toBe(false);
  });
  it('null departure is excluded once any bound is set', () => {
    const o = offer({ departureDate: null });
    expect(matchesDateRange(o, '2026-01-01', null)).toBe(false);
    expect(matchesDateRange(o, null, '2026-12-31')).toBe(false);
    expect(matchesDateRange(o, null, null)).toBe(true);
  });
});

describe('matchesMinRealPct', () => {
  it('null floor passes all', () => {
    expect(matchesMinRealPct(offer({ realPct: null }), null)).toBe(true);
  });
  it('a 0 % floor passes everything, even null realPct', () => {
    expect(matchesMinRealPct(offer({ realPct: null }), 0)).toBe(true);
    expect(matchesMinRealPct(offer({ realPct: -5 }), 0)).toBe(true);
  });
  it('a positive floor drops null and below-floor offers', () => {
    expect(matchesMinRealPct(offer({ realPct: 15 }), 15)).toBe(true);
    expect(matchesMinRealPct(offer({ realPct: 14 }), 15)).toBe(false);
    expect(matchesMinRealPct(offer({ realPct: null }), 15)).toBe(false);
  });
});

describe('matchesSource', () => {
  it('empty passes all; else membership', () => {
    expect(matchesSource(offer({ source: 'invia' }), [])).toBe(true);
    expect(matchesSource(offer({ source: 'invia' }), ['invia', 'exim'])).toBe(true);
    expect(matchesSource(offer({ source: 'fischer' }), ['invia'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyFilters — combinations
// ---------------------------------------------------------------------------

describe('applyFilters', () => {
  const offers = [
    offer({ id: 1, country: 'Řecko', nights: 7, board: 'AI', pricePerPerson: 17000, realPct: 20, source: 'invia', departureDate: '2026-08-10' }),
    offer({ id: 2, country: 'Turecko', nights: 4, board: 'HB', pricePerPerson: 21000, realPct: 5, source: 'exim', departureDate: '2026-07-28' }),
    offer({ id: 3, country: 'Řecko', nights: 10, board: 'AI', pricePerPerson: 9900, realPct: null, source: 'fischer', departureDate: '2026-09-01' }),
    offer({ id: 4, country: 'Egypt', nights: 7, board: 'BB', pricePerPerson: 16800, realPct: 30, source: 'exim', departureDate: '2026-09-05' }),
  ];
  it('empty state passes everything', () => {
    expect(applyFilters(offers, emptyFilterState()).map((o) => o.id)).toEqual([1, 2, 3, 4]);
  });
  it('board filter can target FB (plná penze), previously unreachable via chips', () => {
    const withFB = [...offers, offer({ id: 5, country: 'Řecko', board: 'FB', pricePerPerson: 18000 })];
    expect(applyFilters(withFB, state({ boards: ['FB'] })).map((o) => o.id)).toEqual([5]);
  });
  it('board filter can target unknown-board offers via "Neuvedeno"', () => {
    const withUnknown = [...offers, offer({ id: 6, country: 'Řecko', board: 'unknown', pricePerPerson: 18000 })];
    expect(applyFilters(withUnknown, state({ boards: ['unknown'] })).map((o) => o.id)).toEqual([6]);
  });
  it('country + nights band narrows', () => {
    const s = state({ countries: ['Řecko'], nights: ['6-8'] });
    expect(applyFilters(offers, s).map((o) => o.id)).toEqual([1]);
  });
  it('min real pct drops nulls and below-floor', () => {
    const s = state({ minRealPct: 15 });
    expect(applyFilters(offers, s).map((o) => o.id)).toEqual([1, 4]);
  });
  it('combined country + board + maxPrice + source', () => {
    const s = state({ countries: ['Řecko'], boards: ['AI'], maxPrice: 12000, sources: ['fischer'] });
    expect(applyFilters(offers, s).map((o) => o.id)).toEqual([3]);
  });
  it('date range window', () => {
    const s = state({ dateFrom: '2026-09-01', dateTo: '2026-09-30' });
    expect(applyFilters(offers, s).map((o) => o.id)).toEqual([3, 4]);
  });
  it('a mismatching combination yields empty', () => {
    const s = state({ countries: ['Egypt'], boards: ['AI'] });
    expect(applyFilters(offers, s)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sortBy — including nulls
// ---------------------------------------------------------------------------

describe('sortBy', () => {
  const input = [
    offer({ id: 1, realPct: 10, pricePerPerson: 15000, departureDate: '2026-08-20' }),
    offer({ id: 2, realPct: null, pricePerPerson: 9000, departureDate: null }),
    offer({ id: 3, realPct: 31, pricePerPerson: 21000, departureDate: '2026-07-10' }),
    offer({ id: 4, realPct: 15, pricePerPerson: 12000, departureDate: '2026-09-05' }),
  ];
  it('real: discount desc, nulls last, non-mutating', () => {
    const out = sortBy(input, 'real');
    expect(out.map((o) => o.id)).toEqual([3, 4, 1, 2]);
    expect(input.map((o) => o.id)).toEqual([1, 2, 3, 4]);
  });
  it('price: per-person asc', () => {
    expect(sortBy(input, 'price').map((o) => o.id)).toEqual([2, 4, 1, 3]);
  });
  it('departure: date asc, nulls last', () => {
    expect(sortBy(input, 'departure').map((o) => o.id)).toEqual([3, 1, 4, 2]);
  });
  it('both-null pairs stay stable for real and departure', () => {
    const nulls = [offer({ id: 1, realPct: null, departureDate: null }), offer({ id: 2, realPct: null, departureDate: null })];
    expect(sortBy(nulls, 'real').map((o) => o.id)).toEqual([1, 2]);
    expect(sortBy(nulls, 'departure').map((o) => o.id)).toEqual([1, 2]);
  });
});

describe('applyFilterAndSort', () => {
  it('filters then applies the chosen sort', () => {
    const offers = [
      offer({ id: 1, country: 'Řecko', pricePerPerson: 17000, realPct: 20 }),
      offer({ id: 2, country: 'Řecko', pricePerPerson: 9900, realPct: 5 }),
      offer({ id: 3, country: 'Turecko', pricePerPerson: 8000, realPct: 40 }),
    ];
    const s = state({ countries: ['Řecko'], sort: 'price' });
    expect(applyFilterAndSort(offers, s).map((o) => o.id)).toEqual([2, 1]);
  });
});

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

describe('facets', () => {
  const offers = [
    offer({ country: 'Řecko', departureAirport: 'PRG', source: 'invia', board: 'AI', transport: 'flight' }),
    offer({ country: 'Řecko', departureAirport: 'BRQ', source: 'invia', board: 'AI', transport: 'flight' }),
    offer({ country: 'Řecko', departureAirport: 'PRG', source: 'exim', board: 'HB', transport: 'flight' }),
    offer({ country: 'Turecko', departureAirport: 'PRG', source: 'exim', board: 'HB', transport: 'flight' }),
    offer({ country: null, departureAirport: null, source: 'fischer', board: 'BB', transport: 'own' }),
  ];
  it('country facets: count desc, name tiebreak, nulls skipped', () => {
    expect(countryFacets(offers)).toEqual([
      { value: 'Řecko', count: 3 },
      { value: 'Turecko', count: 1 },
    ]);
  });
  it('airport facets: uppercased, count desc, code tiebreak, null skipped', () => {
    expect(airportFacets(offers)).toEqual([
      { value: 'PRG', count: 3 },
      { value: 'BRQ', count: 1 },
    ]);
  });
  it('source facets: count desc, name tiebreak (exim < invia by cs collation)', () => {
    expect(sourceFacets(offers)).toEqual([
      { value: 'exim', count: 2 },
      { value: 'invia', count: 2 },
      { value: 'fischer', count: 1 },
    ]);
  });
  it('board facets over present codes', () => {
    expect(boardFacets(offers)).toEqual([
      { value: 'AI', count: 2 },
      { value: 'HB', count: 2 },
      { value: 'BB', count: 1 },
    ]);
  });
  it('board facets surface FB and unknown when present in the data', () => {
    const withMore = [
      ...offers,
      offer({ board: 'FB' }),
      offer({ board: 'FB' }),
      offer({ board: 'unknown' }),
    ];
    expect(boardFacets(withMore)).toEqual([
      { value: 'AI', count: 2 },
      { value: 'FB', count: 2 },
      { value: 'HB', count: 2 },
      { value: 'BB', count: 1 },
      { value: 'unknown', count: 1 },
    ]);
  });
  it('hasOwnTransport reflects the data', () => {
    expect(hasOwnTransport(offers)).toBe(true);
    expect(hasOwnTransport([offer({ departureAirport: 'PRG', transport: 'flight' })])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// URL round-trip
// ---------------------------------------------------------------------------

describe('serialize / parse round-trip', () => {
  it('default state serializes to an empty query', () => {
    expect(serializeFilterQuery(emptyFilterState())).toBe('');
  });
  it('parse of an empty query is the default state', () => {
    expect(parseFilterState('')).toEqual(emptyFilterState());
  });
  it('omits every field that holds its default', () => {
    const q = serializeFilterState(state({ countries: ['Řecko'] }));
    expect([...q.keys()]).toEqual(['country']);
  });
  it('round-trips a fully populated state (parse ∘ serialize = identity)', () => {
    const s = state({
      countries: ['Řecko', 'Turecko'],
      maxPrice: 20000,
      nights: ['6-8', '9-12'],
      boards: ['AI', 'HB'],
      airports: ['PRG', 'BRQ'],
      ownTransport: true,
      dateFrom: '2026-07-01',
      dateTo: '2026-09-30',
      minRealPct: 15,
      sources: ['invia', 'exim'],
      sort: 'price',
    });
    const round = parseFilterState(serializeFilterState(s));
    expect(round).toEqual(s);
  });
  it('round-trips each single-field variation', () => {
    const variations: Partial<FilterState>[] = [
      { maxPrice: 15000 },
      { nights: ['13+'] },
      { boards: ['none'] },
      { airports: ['OSR'] },
      { ownTransport: true },
      { dateFrom: '2026-08-01' },
      { dateTo: '2026-08-31' },
      { minRealPct: 25 },
      { sources: ['fischer'] },
      { sort: 'departure' },
    ];
    for (const v of variations) {
      const s = state(v);
      expect(parseFilterState(serializeFilterState(s))).toEqual(s);
    }
  });
  it('a 0 % minRealPct serializes to an empty query and parses back to null (no-op, not a floor)', () => {
    const s = state({ minRealPct: 0 });
    const q = serializeFilterState(s);
    expect([...q.keys()]).toEqual([]);
    expect(parseFilterState(q).minRealPct).toBeNull();
  });
  it('minReal=0 in a URL is ignored on parse (falls back to null, not 0)', () => {
    expect(parseFilterState('minReal=0').minRealPct).toBeNull();
  });
  it('ignores malformed values (garbled URL never throws)', () => {
    const s = parseFilterState('maxPrice=abc&minReal=-4&nights=99,6-8&sort=bogus&from=2026-13&own=x');
    expect(s.maxPrice).toBeNull();
    expect(s.minRealPct).toBeNull();
    expect(s.nights).toEqual(['6-8']); // the bogus band dropped
    expect(s.sort).toBe('real'); // fell back to default
    expect(s.dateFrom).toBeNull(); // not YYYY-MM-DD
    expect(s.ownTransport).toBe(false); // only "1" enables it
  });
  it('uppercases airport codes on parse', () => {
    expect(parseFilterState('airport=prg,brq').airports).toEqual(['PRG', 'BRQ']);
  });
});
