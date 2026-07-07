import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { normalizeBoard, normalizeCountry, offerKeyHash } from '../core/normalize.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://last-minute.zajezdy.cz';
const SEARCH_DATA_MARKER = 'window.searchData = ';

// Fixed set of destination/category slugs (recon-confirmed, spec §3 row 6). Robots.txt on
// this host disallows `/api/` paths and `?page=` query params, so coverage comes from
// breadth across these SSR listing pages (10 tourResults each) rather than pagination.
//
// Exotic slugs (spec §16.2) appended below. Each was live-verified 2026-07-07 (Chrome UA, 5s
// crawl-delay honored): `GET https://last-minute.zajezdy.cz/<slug>/` must return a page whose
// window.searchData carries a non-empty tourResults. Verdicts (HTTP 200 / tourResults=10 /
// 30 departures each): spojene-arabske-emiraty ✓, thajsko ✓, maledivy ✓, mauricius ✓,
// dominikanska-republika ✓ (all added). Also verified ✓ but OMITTED to keep SLUGS ≤ 12 (5s
// gap → ~60 s/scan politeness ceiling, spec §16.2): zanzibar, kapverdy — both are already
// covered by dedicated exotic sources (Datour/FIRO for Zanzibar, FIRO id 102 + eximtours for
// Kapverdy). Candidate `exotika` was REJECTED: HTTP 404 (not a real slug on this host).
const SLUGS = [
  'recko',
  'turecko',
  'egypt',
  'chorvatsko',
  'bulharsko',
  'all-inclusive',
  'letecky-praha',
  // exotic (live-verified 2026-07-07), top-5 by the exotika watch profile's own country order:
  'thajsko',
  'maledivy',
  'mauricius',
  'spojene-arabske-emiraty',
  'dominikanska-republika',
];

interface RawMoney {
  amount?: number;
  currency?: string;
}

interface RawTourUrl {
  title?: string;
  text?: string;
  url?: string;
}

interface RawTour {
  id?: number;
  name?: string;
  countryName?: string;
  dest?: string;
  place?: string;
  classification?: number;
  ckName?: string;
  baseUrl?: string;
}

interface RawDeparture {
  odjezdPrijezd?: string;
  letiste?: string;
  strava?: string;
  totalAdultPrice?: RawMoney;
  poSleve?: string;
  url?: RawTourUrl;
  delka?: string;
}

interface RawTourResult {
  tour?: RawTour;
  startingPrice?: RawMoney;
  departures?: RawDeparture[];
}

interface RawSearchData {
  tourResults?: RawTourResult[];
}

/**
 * Extracts the `window.searchData = {...};` JSON blob embedded in Zajezdy.cz's SSR listing
 * pages. Uses a balanced-brace scan (tracking string literals so braces inside JSON string
 * values, e.g. HTML fragments in `icons`/`transportSymbol`, don't throw off the depth count)
 * rather than a DOTALL regex: a naive `};`-terminated regex could truncate early on payloads
 * where a string value itself contains the literal sequence `};`, so we track string state
 * explicitly instead of relying on that terminator.
 */
function extractSearchData(html: string): RawSearchData | null {
  const idx = html.indexOf(SEARCH_DATA_MARKER);
  if (idx === -1) return null;
  const start = idx + SEARCH_DATA_MARKER.length;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  if (end === -1) return null;

  try {
    return JSON.parse(html.slice(start, end)) as RawSearchData;
  } catch {
    return null;
  }
}

// Matches Czech weekday-prefixed short dates like "St 15. 7." or "Ne 2. 8." (day/month, no
// year — the year is inferred separately since Zajezdy never prints it on these labels).
const DATE_RE = /(\d{1,2})\.\s*(\d{1,2})\./g;

/**
 * Parses `odjezdPrijezd` (e.g. "St 15. 7. – St 22. 7.") into a departure ISO date + nights.
 * The label carries no year: if the departure month is earlier than the current month, the
 * trip is assumed to fall in the next calendar year (mirrors the `zajezdyAllowedNow`/other
 * adapters' "last minute" framing where listings are near-term but can roll into January).
 */
function parseOdjezdPrijezd(raw: string | undefined, now: Date): { departureDate: string | null; nights: number | null } {
  if (!raw) return { departureDate: null, nights: null };
  const matches = [...raw.matchAll(DATE_RE)];
  if (matches.length < 2) return { departureDate: null, nights: null };

  const [, startDayRaw, startMonthRaw] = matches[0]!;
  const [, endDayRaw, endMonthRaw] = matches[1]!;
  const startDay = Number(startDayRaw);
  const startMonth = Number(startMonthRaw);
  const endDay = Number(endDayRaw);
  const endMonth = Number(endMonthRaw);

  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const departureYear = startMonth < currentMonth ? currentYear + 1 : currentYear;

  const startMs = Date.UTC(departureYear, startMonth - 1, startDay);
  // The arrival date can cross a year boundary relative to the departure (e.g. departs late
  // December, returns early January); if the end month is numerically before the start
  // month, it belongs to the following year.
  const endYear = endMonth < startMonth ? departureYear + 1 : departureYear;
  const endMs = Date.UTC(endYear, endMonth - 1, endDay);

  const nights = Math.round((endMs - startMs) / (24 * 60 * 60 * 1000));
  const departureDate = `${departureYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;

  return { departureDate, nights: nights > 0 ? nights : null };
}

/**
 * Parses `poSleve` (e.g. "po slevě 36&nbsp;%", possibly empty) into a discount percentage,
 * decoding the literal `&nbsp;` HTML entity that appears raw inside the JSON string value.
 */
function parsePoSleve(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/&nbsp;/g, ' ');
  const match = cleaned.match(/(\d+)\s*%/);
  if (!match) return null;
  const pct = Number(match[1]);
  return pct > 0 && pct < 100 ? pct : null;
}

/** Extracts the tour id from a detail URL like `.../dovolena-...-z3117506/2851209183/?...`. */
function extractTourId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/-z(\d+)\//);
  return match?.[1] ?? null;
}

function buildOffer(tourResult: RawTourResult, departure: RawDeparture, now: Date): NormalizedOffer | null {
  const tour = tourResult.tour;
  if (!tour) return null;

  const title = tour.name?.trim();
  if (!title) return null;

  const url = departure.url?.url;
  if (!url) return null;

  const pricePerPerson = departure.totalAdultPrice?.amount;
  if (pricePerPerson === undefined || pricePerPerson === null || !(pricePerPerson > 0)) return null;

  const { departureDate, nights } = parseOdjezdPrijezd(departure.odjezdPrijezd, now);

  const claimedDiscountPct = parsePoSleve(departure.poSleve);
  const claimedOriginalPrice =
    claimedDiscountPct !== null ? Math.round(pricePerPerson / (1 - claimedDiscountPct / 100)) : null;

  // These are flight/last-minute listings; a departure airport means it's a flight package.
  // Absent that, fall back to 'unknown' rather than guessing 'own'/'bus' from tour data that
  // doesn't reliably encode transport mode.
  const transport = departure.letiste ? 'flight' : 'unknown';

  const tourId = extractTourId(url) ?? extractTourId(tour.baseUrl);
  const board = normalizeBoard(departure.strava);
  const sourceOfferKey = offerKeyHash([tourId ?? title, departureDate, nights, board]);

  return {
    source: 'zajezdy',
    sourceOfferKey,
    title,
    country: normalizeCountry(tour.countryName ?? null),
    locality: tour.dest?.trim() || null,
    stars: typeof tour.classification === 'number' && tour.classification > 0 ? tour.classification : null,
    board,
    transport,
    departureAirport: departure.letiste?.trim() || null,
    departureDate,
    nights,
    pricePerPerson,
    priceTotal: null,
    claimedOriginalPrice,
    claimedDiscountPct,
    omnibusLowestPrice: null,
    tourOperator: tour.ckName?.trim() || null,
    url,
  };
}

/**
 * Parses one Zajezdy.cz listing page's `window.searchData` JSON into normalized offers.
 * Each `tourResults[]` entry is a hotel; each of its `departures[]` is a distinct
 * hotel+term combination (dates/nights/price differ), so every departure becomes its own
 * `NormalizedOffer` — a tour with 3 departures yields 3 offers, not 1.
 */
export function parseZajezdy(html: string, now: Date = new Date()): NormalizedOffer[] {
  const data = extractSearchData(html);
  if (!data?.tourResults) return [];

  const seen = new Set<string>();
  const offers: NormalizedOffer[] = [];

  for (const tourResult of data.tourResults) {
    for (const departure of tourResult.departures ?? []) {
      const offer = buildOffer(tourResult, departure, now);
      if (!offer) continue;
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      offers.push(offer);
    }
  }

  return offers;
}

const PRAGUE_HOUR_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Prague',
  hour: 'numeric',
  hour12: false,
});

/**
 * Robots.txt / politeness for Zajezdy.cz restricts crawling to 08:00-24:00 Europe/Prague
 * (see spec §3 row 6: "Crawl-delay 5 s, requesty jen 08-24 h"). Returns true only within
 * that window; used by `fetchOffers` to skip fetching entirely outside it.
 */
export function zajezdyAllowedNow(now: Date = new Date()): boolean {
  const hourStr = PRAGUE_HOUR_FORMATTER.format(now);
  // Intl can format midnight as "24" instead of "0" depending on locale/runtime; normalize.
  const hour = Number(hourStr) % 24;
  return hour >= 8;
}

/**
 * Core fetch implementation, parameterized by `now` for testability (time-window gating and
 * date-inference both depend on it). `zajezdy.fetchOffers` (the `SourceAdapter`-conforming
 * export) is a thin wrapper that always passes the real current time; tests call this
 * function directly to exercise specific points in the crawl window.
 */
export async function fetchZajezdyOffers(ctx: SourceContext, now: Date = new Date()): Promise<NormalizedOffer[]> {
  if (!zajezdyAllowedNow(now)) {
    ctx.log('zajezdy: skipping fetch, outside allowed crawl window (08:00-24:00 Europe/Prague)');
    return [];
  }

  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  let lastError: unknown;
  let successCount = 0;

  for (const slug of SLUGS) {
    const url = `${BASE_URL}/${slug}/`;
    let offers: NormalizedOffer[];
    try {
      const html = await ctx.http.text(url);
      offers = parseZajezdy(html, now);
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // The site is actively blocking us: stop fetching remaining slugs immediately
        // (politeness) but keep whatever offers earlier slugs already yielded. Record the block as
        // lastError so a block BEFORE the first success still trips the successCount===0 rethrow.
        lastError = err;
        ctx.log(`zajezdy: slug ${slug} blocked (${err.message}), stopping`);
        break;
      }
      // Any other per-slug failure (network error, parse error, transient 5xx exhausted)
      // should not sink the whole fetch — log and move on to the next slug.
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`zajezdy: slug ${slug} failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every slug failed: this is not "market empty" — rethrow (fischer pattern) so runScan records
    // this source 'failed' rather than degrading to [] (which would flip known offers inactive and
    // mute the health alert). A block on the first slug lands here → BLOCKED marker / 24h backoff.
    // NB: the outside-crawl-window early return above still returns [] (intentional skip, not a
    // failure) — this guard only fires once we've actually attempted (and lost) every slug.
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`zajezdy: all ${SLUGS.length} slugs failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(`zajezdy: fetched ${all.length} offers across ${SLUGS.length} slugs`);
  return all;
}

export const zajezdy: SourceAdapter = {
  name: 'zajezdy',
  fetchOffers: (ctx: SourceContext) => fetchZajezdyOffers(ctx),
};
