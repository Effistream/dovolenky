/**
 * Pure, framework-free filtering + sorting for the Terminál board (Task 29).
 *
 * Everything here is side-effect free and unit-tested (web/src/lib/filters.test.ts)
 * so it can run under node with no DOM. The board loads the full active /api/offers
 * set once per profile (the profile is the only server-side filter — see api.ts);
 * every other narrowing lives here and runs in the browser.
 *
 * Three concerns:
 *  1. `FilterState` — the single source of truth for the FilterBar UI + URL.
 *  2. individually-testable predicates + `applyFilters(offers, state)`.
 *  3. `parseFilterState` / `serializeFilterState` — a URL round-trip that omits
 *     defaults, so a pristine board carries a clean, shareable URL.
 *
 * Copy follows design-system/MASTER.md: Czech, concrete, no exclamations.
 */
import type { Offer } from './types.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Board sort orders. Default is real discount desc, nulls last. */
export type SortKey = 'real' | 'price' | 'departure';

/** Nights band ids. Each maps to an inclusive numeric range (see NIGHTS_BANDS). */
export type NightsBand = 'le5' | '6-8' | '9-12' | '13+';

/**
 * The complete client-side filter state. Empty arrays / nulls are the defaults
 * (pass-all). `serializeFilterState` omits every field that still holds its
 * default, so the URL only ever carries what the user actively changed.
 */
export interface FilterState {
  /** Selected countries (multi). Empty = all. Matched against Offer.country. */
  countries: string[];
  /** Max price per person in CZK, or null = no ceiling. */
  maxPrice: number | null;
  /** Selected nights bands (multi). Empty = all. */
  nights: NightsBand[];
  /** Selected board codes (multi): AI · HB · BB · none. Empty = all. */
  boards: string[];
  /** Selected departure airports (multi, uppercased). Empty = all. */
  airports: string[];
  /** Include own-transport offers (transport !== flight, no airport). */
  ownTransport: boolean;
  /** Departure on/after this ISO date (YYYY-MM-DD), or null. */
  dateFrom: string | null;
  /** Departure on/before this ISO date (YYYY-MM-DD), or null. */
  dateTo: string | null;
  /** Minimum real discount in whole percent (0/10/15/25…), or null = no floor. */
  minRealPct: number | null;
  /** Selected sources (multi). Empty = all. Matched against Offer.source. */
  sources: string[];
  /** Board sort order. */
  sort: SortKey;
}

/** A pristine state: nothing selected, default sort. */
export function emptyFilterState(): FilterState {
  return {
    countries: [],
    maxPrice: null,
    nights: [],
    boards: [],
    airports: [],
    ownTransport: false,
    dateFrom: null,
    dateTo: null,
    minRealPct: null,
    sources: [],
    sort: 'real',
  };
}

/** True when the state carries no active narrowing and the default sort. */
export function isDefaultState(s: FilterState): boolean {
  return activeFilterCount(s) === 0 && s.sort === 'real';
}

/**
 * How many filters are active — the badge next to „Více filtrů". Sort is not a
 * filter, so it is excluded. Each populated multi-select counts as one, each set
 * scalar (price / date / minRealPct / ownTransport) counts as one.
 */
export function activeFilterCount(s: FilterState): number {
  let n = 0;
  if (s.countries.length > 0) n++;
  if (s.maxPrice != null) n++;
  if (s.nights.length > 0) n++;
  if (s.boards.length > 0) n++;
  if (s.airports.length > 0 || s.ownTransport) n++;
  if (s.dateFrom != null || s.dateTo != null) n++;
  if (s.minRealPct != null) n++;
  if (s.sources.length > 0) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Nights bands
// ---------------------------------------------------------------------------

/** Inclusive [min, max] per band; max=null means open-ended (13+). */
export const NIGHTS_BANDS: Record<NightsBand, { min: number; max: number | null; label: string }> = {
  le5: { min: 0, max: 5, label: '≤ 5' },
  '6-8': { min: 6, max: 8, label: '6–8' },
  '9-12': { min: 9, max: 12, label: '9–12' },
  '13+': { min: 13, max: null, label: '13+' },
};

const NIGHTS_BAND_KEYS = Object.keys(NIGHTS_BANDS) as NightsBand[];

/** True when `nights` falls inside the given band. Null nights never match. */
export function nightsInBand(nights: number | null, band: NightsBand): boolean {
  if (nights == null || !Number.isFinite(nights)) return false;
  const { min, max } = NIGHTS_BANDS[band];
  return nights >= min && (max == null || nights <= max);
}

// ---------------------------------------------------------------------------
// Predicates — each is total and independently tested. An empty/nullish filter
// field is always pass-all so `applyFilters` can AND them without special cases.
// ---------------------------------------------------------------------------

export function matchesCountry(offer: Offer, countries: string[]): boolean {
  if (countries.length === 0) return true;
  return offer.country != null && countries.includes(offer.country);
}

export function matchesMaxPrice(offer: Offer, maxPrice: number | null): boolean {
  if (maxPrice == null) return true;
  return offer.pricePerPerson <= maxPrice;
}

export function matchesNights(offer: Offer, bands: NightsBand[]): boolean {
  if (bands.length === 0) return true;
  return bands.some((b) => nightsInBand(offer.nights, b));
}

export function matchesBoard(offer: Offer, boards: string[]): boolean {
  if (boards.length === 0) return true;
  return boards.includes(offer.board);
}

/**
 * Departure filter. `airports` (uppercased codes) and the `ownTransport` toggle
 * are ORed: with neither set, everything passes. An offer counts as own-transport
 * when it has no departure airport and its transport is not a flight (bus / own /
 * unknown-without-airport), matching departureLabel's "vlastní/bus" fallback.
 */
export function matchesDeparture(
  offer: Offer,
  airports: string[],
  ownTransport: boolean,
): boolean {
  if (airports.length === 0 && !ownTransport) return true;
  const code = offer.departureAirport?.toUpperCase() ?? null;
  if (code != null && airports.includes(code)) return true;
  if (ownTransport && isOwnTransport(offer)) return true;
  return false;
}

/** An offer with no flight airport → own/bus/coach transport. */
export function isOwnTransport(offer: Offer): boolean {
  const hasAirport = offer.departureAirport != null && offer.departureAirport.trim() !== '';
  return !hasAirport && offer.transport !== 'flight';
}

/**
 * Departure date window. Compares the ISO date lexicographically (YYYY-MM-DD
 * sorts correctly as a string), so no Date parsing is needed. A null departure
 * date is excluded whenever either bound is set — an undated offer can't be
 * proven to fall inside the window.
 */
export function matchesDateRange(
  offer: Offer,
  from: string | null,
  to: string | null,
): boolean {
  if (from == null && to == null) return true;
  const d = offer.departureDate;
  if (d == null) return false;
  if (from != null && d < from) return false;
  if (to != null && d > to) return false;
  return true;
}

export function matchesMinRealPct(offer: Offer, minRealPct: number | null): boolean {
  if (minRealPct == null) return true;
  // A null realPct (still collecting history) can't clear a positive floor.
  if (minRealPct <= 0) return true;
  return offer.realPct != null && offer.realPct >= minRealPct;
}

export function matchesSource(offer: Offer, sources: string[]): boolean {
  if (sources.length === 0) return true;
  return sources.includes(offer.source);
}

// ---------------------------------------------------------------------------
// Combine + sort
// ---------------------------------------------------------------------------

/** ANDs every predicate. Order is cheapest-first; result is a new array. */
export function applyFilters(offers: Offer[], s: FilterState): Offer[] {
  return offers.filter(
    (o) =>
      matchesCountry(o, s.countries) &&
      matchesMaxPrice(o, s.maxPrice) &&
      matchesNights(o, s.nights) &&
      matchesBoard(o, s.boards) &&
      matchesDeparture(o, s.airports, s.ownTransport) &&
      matchesDateRange(o, s.dateFrom, s.dateTo) &&
      matchesMinRealPct(o, s.minRealPct) &&
      matchesSource(o, s.sources),
  );
}

/**
 * Board sort. Non-mutating (spreads first) and stable within a key:
 *  - 'real'      → real discount desc, nulls last (default; mirrors the API).
 *  - 'price'     → price per person asc.
 *  - 'departure' → departure date asc, nulls last.
 */
export function sortBy(offers: Offer[], key: SortKey): Offer[] {
  const copy = [...offers];
  if (key === 'price') {
    return copy.sort((a, b) => a.pricePerPerson - b.pricePerPerson);
  }
  if (key === 'departure') {
    return copy.sort((a, b) => {
      if (a.departureDate == null && b.departureDate == null) return 0;
      if (a.departureDate == null) return 1;
      if (b.departureDate == null) return -1;
      return a.departureDate < b.departureDate ? -1 : a.departureDate > b.departureDate ? 1 : 0;
    });
  }
  // 'real' — discount desc, nulls last.
  return copy.sort((a, b) => {
    if (a.realPct == null && b.realPct == null) return 0;
    if (a.realPct == null) return 1;
    if (b.realPct == null) return -1;
    return b.realPct - a.realPct;
  });
}

/** Filter then sort — the pipeline the board renders. */
export function applyFilterAndSort(offers: Offer[], s: FilterState): Offer[] {
  return sortBy(applyFilters(offers, s), s.sort);
}

// ---------------------------------------------------------------------------
// Derived facets (country / airport / source counts for the chip rows)
// ---------------------------------------------------------------------------

export interface Facet {
  value: string;
  count: number;
}

/**
 * Distinct countries with occurrence counts, sorted by count desc then name
 * (cs collation) for ties — the „Řecko 41" chips. Null countries are skipped.
 */
export function countryFacets(offers: Offer[]): Facet[] {
  return facetsBy(offers, (o) => o.country);
}

/** Distinct departure airports (uppercased) with counts, count desc then code. */
export function airportFacets(offers: Offer[]): Facet[] {
  return facetsBy(offers, (o) => {
    const a = o.departureAirport;
    return a != null && a.trim() !== '' ? a.toUpperCase() : null;
  });
}

/** Distinct sources with counts, count desc then name. */
export function sourceFacets(offers: Offer[]): Facet[] {
  return facetsBy(offers, (o) => o.source);
}

/** True when any loaded offer is own-transport (drives the „vlastní doprava" chip). */
export function hasOwnTransport(offers: Offer[]): boolean {
  return offers.some(isOwnTransport);
}

/** Distinct board codes present in the data, count desc then code. */
export function boardFacets(offers: Offer[]): Facet[] {
  return facetsBy(offers, (o) => o.board);
}

function facetsBy(offers: Offer[], pick: (o: Offer) => string | null): Facet[] {
  const counts = new Map<string, number>();
  for (const o of offers) {
    const v = pick(o);
    if (v == null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'cs'));
}

// ---------------------------------------------------------------------------
// URL round-trip — parse ∘ serialize = identity, defaults omitted.
// ---------------------------------------------------------------------------

/**
 * Query-param names. Kept short + stable: these are user-facing (shareable URLs),
 * so renaming a key silently breaks old bookmarks. Multi-values are comma-joined.
 */
const PARAM = {
  countries: 'country',
  maxPrice: 'maxPrice',
  nights: 'nights',
  boards: 'board',
  airports: 'airport',
  ownTransport: 'own',
  dateFrom: 'from',
  dateTo: 'to',
  minRealPct: 'minReal',
  sources: 'source',
  sort: 'sort',
} as const;

const SORT_KEYS: SortKey[] = ['real', 'price', 'departure'];

/**
 * Serialize non-default fields into URLSearchParams. Defaults are omitted so a
 * pristine board keeps a bare URL; the key order is fixed for a deterministic
 * query string (round-trip + snapshot friendly).
 */
export function serializeFilterState(s: FilterState): URLSearchParams {
  const q = new URLSearchParams();
  if (s.countries.length > 0) q.set(PARAM.countries, s.countries.join(','));
  if (s.maxPrice != null) q.set(PARAM.maxPrice, String(s.maxPrice));
  if (s.nights.length > 0) q.set(PARAM.nights, s.nights.join(','));
  if (s.boards.length > 0) q.set(PARAM.boards, s.boards.join(','));
  if (s.airports.length > 0) q.set(PARAM.airports, s.airports.join(','));
  if (s.ownTransport) q.set(PARAM.ownTransport, '1');
  if (s.dateFrom != null) q.set(PARAM.dateFrom, s.dateFrom);
  if (s.dateTo != null) q.set(PARAM.dateTo, s.dateTo);
  if (s.minRealPct != null) q.set(PARAM.minRealPct, String(s.minRealPct));
  if (s.sources.length > 0) q.set(PARAM.sources, s.sources.join(','));
  if (s.sort !== 'real') q.set(PARAM.sort, s.sort);
  return q;
}

/** Serialize to a query string (no leading „?"). Empty when the state is default. */
export function serializeFilterQuery(s: FilterState): string {
  return serializeFilterState(s).toString();
}

/**
 * Parse a URLSearchParams (or query string) back into a FilterState. Unknown /
 * malformed values fall back to the default for that field — a garbled URL never
 * throws, it just ignores the bad part. Guarantees parse(serialize(s)) deep-equals
 * s for any state produced by this module.
 */
export function parseFilterState(input: URLSearchParams | string): FilterState {
  const q = typeof input === 'string' ? new URLSearchParams(input) : input;
  const s = emptyFilterState();

  s.countries = splitList(q.get(PARAM.countries));
  s.maxPrice = parsePosInt(q.get(PARAM.maxPrice));
  s.nights = splitList(q.get(PARAM.nights)).filter(isNightsBand);
  s.boards = splitList(q.get(PARAM.boards));
  s.airports = splitList(q.get(PARAM.airports)).map((a) => a.toUpperCase());
  s.ownTransport = q.get(PARAM.ownTransport) === '1';
  s.dateFrom = parseIsoDate(q.get(PARAM.dateFrom));
  s.dateTo = parseIsoDate(q.get(PARAM.dateTo));
  s.minRealPct = parseNonNegInt(q.get(PARAM.minRealPct));
  s.sources = splitList(q.get(PARAM.sources));

  const sort = q.get(PARAM.sort);
  s.sort = sort != null && (SORT_KEYS as string[]).includes(sort) ? (sort as SortKey) : 'real';

  return s;
}

function splitList(raw: string | null): string[] {
  if (raw == null || raw === '') return [];
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function isNightsBand(v: string): v is NightsBand {
  return (NIGHTS_BAND_KEYS as string[]).includes(v);
}

/** Positive integer (price ceiling) or null. Zero/negative/NaN → null. */
function parsePosInt(raw: string | null): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Non-negative integer (a 0 % floor is meaningful) or null. */
function parseNonNegInt(raw: string | null): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Accepts a strict YYYY-MM-DD string; anything else → null. */
function parseIsoDate(raw: string | null): string | null {
  if (raw == null) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}
