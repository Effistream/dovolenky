import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { mapDerTours } from './der.js';
import { SourceBlockedError } from '../core/http.js';

const BASE_URL = 'https://www.etravel.cz';
const WINDOW_DAYS = 60;
const NIGHTS = '7|8|9|10|11|12|13|14';

// Page size (`pitg` = page items to get). The endpoint defaults to 20 and the site's own
// "Dalších 20" button re-fires it with pitg/pstg; 40 is a deliberate compromise, live-measured
// 2026-07-29: results are strictly price-ascending, so the first 40 of a destination reach well
// into the discounted mid-band (Egypt: 12 of the cheapest 20 carry a discount, 111 of the
// cheapest 200 do) while keeping one response ≈0.5 MB and ≈2 s. Deeper paging (pstg>0) is
// deliberately NOT done — breadth across destinations buys more distinct inventory per request
// than depth in one, and every extra request costs the 3 s per-host politeness gap.
const PAGE_SIZE = 40;

// HARD REQUEST BUDGET. src/core/run.ts aborts an adapter whose fetchOffers exceeds
// ADAPTER_FETCH_TIMEOUT_MS (240 s) and records the source 'failed' — which deactivates its whole
// inventory, strictly worse than partial coverage. HttpClient serializes per host with a 3 s gap,
// so a run costs requests × (3 s gap + server time). eTravel's server time is the volatile part
// and it swings hard: three full 25-request runs on 2026-07-29 took 80 s, 160 s and (over 29
// destinations) 179 s, individual destinations ranging 0.3-12 s. The request count alone therefore
// does NOT bound the run, hence two independent guards:
//   MAX_REQUESTS  — structural cap; a future edit to TARGET_COUNTRIES (or eTravel splitting a
//                   country into more categories) cannot silently multiply the request count.
//   RUN_BUDGET_MS — wall-clock cap on the whole fetchOffers call, discovery included (that is what
//                   run.ts's 240 s covers), so a slow eTravel day costs coverage, not the source.
//
// The subtle part is the TAIL. A between-destinations deadline check only bounds when the LAST
// request *starts*; on its own it says nothing about when that request ends. And a hung request is
// not one 25 s attempt: HttpClient retries up to MAX_ATTEMPTS = 3 with 0.5 s + 2 s backoffs, so a
// dead host costs 3 s gap + 3 × 25 s + 2.5 s ≈ 80 s. A bare 175 s deadline could thus finish at
// ~255 s and trip the very timeout it exists to prevent.
//
// So the remaining budget is also handed to the request itself as an AbortSignal. HttpClient
// combines it with its own per-attempt timeout (AbortSignal.any), so once the budget is spent every
// remaining retry aborts instantly instead of burning another 25 s. That bounds the whole call at
// RUN_BUDGET_MS + one politeness gap + the 2.5 s of backoff sleeps ≈ 205 s, ~35 s clear of 240 s,
// no matter how the site misbehaves. Destinations are only started with MIN_REQUEST_BUDGET_MS left,
// so the last one queried still gets a fair chance rather than a guaranteed abort.
const MAX_REQUESTS = 40;
const RUN_BUDGET_MS = 200_000;
const MIN_REQUEST_BUDGET_MS = 20_000;

// A TARGET country only produces offers if `discoverDestinationIds` (the categories response of
// `getsearchresult?tt=1`) returns a `destinations[]` entry whose `name` matches exactly and whose
// `destinationIds` is non-empty; otherwise it is gracefully skipped ("no destination ids found").
// All 24 names below were live-verified against that categories response on 2026-07-29 (Chrome UA)
// and each returned mappable tours in the same run. Spelling follows eTravel's own číselník, which
// is not always the project's canonical country name ("Tanzánie" normalizes to Tanzanie ✓, but
// "Kapverdské ostrovy" does NOT fold into the canonical "Kapverdy" — those offers reach the board
// but miss the exotika profile until core/normalize.ts learns the alias). Zanzibar is still
// deliberately absent: it is not a country-level category on eTravel (it is rolled into Tanzánie,
// which IS queried below and covers that inventory).
//
// ORDER IS LOAD-BEARING: destinations are queried in this order and the RUN_BUDGET_MS guard drops
// the tail, so config/watch.yaml's profile countries come first — leto-more's eight, then
// exotika's — and the two board-only extras (Portugalsko, Tunisko: real inventory that no other
// adapter targets, but in no profile) come last, where a slow day costs the least.
//
// The list grew from 12 to 24 on 2026-07-29: the previous one served 3 of leto-more's 8 countries
// and none of Španělsko (eTravel's single biggest destination, 2313 in-window tours), Bulharsko
// (cheapest inventory on the site, from 5 579 CZK/person), Kypr, Chorvatsko or Itálie. Countries
// the exotika profile names but eTravel has no country category for at all (Filipíny, Réunion,
// Nepál, Kambodža, Madagaskar, Jihoafrická republika) stay delegated to Datour/FIRO/dovolenkovani,
// same rationale as Zanzibar. Three more — Peru, Japonsko and Namibia — DO exist in the číselník
// but are deliberately not queried: they sit at its long tail (long-haul sightseeing, not the
// beach-package inventory this `tt=1` flight-package query returns), and three more requests would
// push the run toward the RUN_BUDGET_MS margin for destinations that have never produced a match.
// Add them only together with a re-measured budget (and note "Namibia" is eTravel's spelling —
// core/normalize.ts would need the alias to the profile's "Namibie", exactly as with Kapverdy).
// Malta/Albánie/Černá Hora/Maroko were queried in testing and dropped again: they are in no
// profile, and at ~6 s per destination the request budget is better spent on margin than on
// inventory nothing watches.
const TARGET_COUNTRIES = [
  // leto-more profile (all 8)
  'Španělsko',
  'Řecko',
  'Turecko',
  'Egypt',
  'Bulharsko',
  'Itálie',
  'Kypr',
  'Chorvatsko',
  // exotika profile (14 of its 24 names exist as eTravel country categories)
  'Spojené arabské emiráty',
  'Maledivy',
  'Thajsko',
  'Dominikánská republika',
  'Mauricius',
  'Kuba',
  'Mexiko',
  'Srí Lanka',
  'Vietnam',
  'Tanzánie',
  'Indonésie',
  'Seychely',
  'Kapverdské ostrovy',
  'Keňa',
  // board-only, no profile — first to be dropped if the deadline trips
  'Portugalsko',
  'Tunisko',
];

/**
 * eTravel runs on the DER Touristik platform (shared with Fischer/Exim — see der.ts). Its API is
 * the only one in this project that even *carries* an official Omnibus 30-day-minimum price field
 * (`tour.price.lowestPrice`), but on this search-listing endpoint the field is empirically always
 * null — 0 of 200 sampled Egypt tours, and 0 of 902 offers in each of three independent full live
 * runs (2026-07-29), had it populated. der.ts null-guards it; do not treat eTravel as a working
 * source of that field.
 *
 * Destination IDs are NOT the country-level ids from `getfilter`'s `geo.sdo` (`type: "st"`,
 * e.g. Řecko=63064): passing that id alone into `getsearchresult`'s `d=` param yields
 * `toursCount: 0` — confirmed live. The API instead expects a `|`-joined list of the
 * finer-grained region ids that belong to that country. The easiest reliable way to get that
 * list is calling `getsearchresult` itself with NO `d` filter (just `tt=1`): it then returns
 * `resultType: "categories"` with `categories[].destinations[]`, each carrying
 * `{ id, name, destinationIds }` — `destinationIds` is exactly the pipe-joined region-id string
 * to feed back into a real `d=` query for that country. So `fetchOffers` does one categories
 * discovery request, then one getsearchresult request per target country — 25 requests today,
 * hard-capped by MAX_REQUESTS / RUN_BUDGET_MS. Live 2026-07-29, three independent runs: 902 offers,
 * 25 requests, 24 countries, price/person 5 579-79 936 CZK, ~140 carrying a claimed discount (was:
 * 226 offers, 12 countries, 6 902-76 400 CZK, 28 discounted). The offer numbers came out identical
 * across those runs; the WALL CLOCK did not — 80 s, 161 s and 78 s for the very same 25 requests.
 * Treat any single timing measurement of this source as an anecdote, not a budget.
 *
 * Results are price-ascending with no sort parameter exposed, so a query returns the N cheapest
 * tours of that destination — which is what a deal watcher wants, but it also means the top of
 * every list is dominated by cheap foreign departures (Vienna/Katowice/Budapest/Munich). The
 * `to=` origin-airport filter the site's own frontend sends is deliberately NOT used: filtering
 * to Czech airports would hide real, bookable, cheaper departures. der.ts now reports the actual
 * origin in `departureAirport` instead, so the board can label and filter them.
 */
interface CategoryDestination {
  id: number;
  name: string;
  destinationIds: string;
}

interface CategoriesResponse {
  categories: Array<{ destinations: CategoryDestination[] }>;
}

interface SearchResultResponse {
  tours: unknown[];
  toursCount: number;
}

async function discoverDestinationIds(ctx: SourceContext): Promise<Map<string, string>> {
  const url = `${BASE_URL}/api/searchapi/getsearchresult?tt=1`;
  const res = await ctx.http.json<CategoriesResponse>(url);
  const all = res.categories.flatMap((c) => c.destinations);
  const byName = new Map<string, string>();
  for (const d of all) {
    byName.set(d.name, d.destinationIds);
  }
  return byName;
}

function searchUrl(destinationIds: string, today: Date): string {
  const dd = today.toISOString().slice(0, 10);
  const rdDate = new Date(today.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rd = rdDate.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    ds: '0',
    tt: '1',
    d: destinationIds,
    dd,
    rd,
    er: '0',
    isss: '0',
    nn: NIGHTS,
    ac1: '2',
    kc1: '0',
    ic1: '0',
    // `pitg` = page size, `pstg` = items to skip. Without them the endpoint silently caps every
    // destination at its default 20 rows — the truncation this adapter shipped with until
    // 2026-07-29 (226 offers/run, invariant across 107 recorded scans).
    pitg: String(PAGE_SIZE),
    pstg: '0',
  });
  return `${BASE_URL}/api/searchapi/getsearchresult?${params.toString()}`;
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
  // Started BEFORE discovery: run.ts's 240 s timeout covers this whole function, so the discovery
  // request has to be inside the deadline budget too.
  const startedAt = Date.now();

  let destinationIds: Map<string, string>;
  try {
    destinationIds = await discoverDestinationIds(ctx);
  } catch (err) {
    // Total failure of the discovery request is NOT "market empty" — it means the request
    // itself failed. Rethrow so runScan records this source 'failed' (and skips
    // markMissedOffers) rather than swallowing to [] and flipping inventory inactive.
    const message = err instanceof Error ? err.message : String(err);
    ctx.log(`etravel: destination discovery failed (${message}), aborting`);
    throw err;
  }

  const all: NormalizedOffer[] = [];
  const seen = new Set<string>();
  const today = new Date();
  let lastError: unknown;
  let successCount = 0;
  // Discovery already spent one request against the budget.
  let requestCount = 1;

  for (const country of TARGET_COUNTRIES) {
    // Both guards stop with what we have rather than risk runScan's 240 s adapter timeout, which
    // would fail the whole source (deactivating its inventory) instead of merely shortening its
    // coverage. TARGET_COUNTRIES is ordered so the tail we drop is the least-watched.
    if (requestCount >= MAX_REQUESTS) {
      ctx.log(`etravel: request budget ${MAX_REQUESTS} reached, stopping before ${country}`);
      break;
    }
    const elapsed = Date.now() - startedAt;
    const remainingMs = RUN_BUDGET_MS - elapsed;
    if (remainingMs < MIN_REQUEST_BUDGET_MS) {
      ctx.log(`etravel: ${Math.round(elapsed / 1000)}s elapsed, stopping before ${country}`);
      break;
    }

    const ids = destinationIds.get(country);
    if (!ids) {
      ctx.log(`etravel: no destination ids found for ${country}, skipping`);
      continue;
    }

    let offers: NormalizedOffer[];
    try {
      const url = searchUrl(ids, today);
      requestCount += 1;
      // Hand the leftover budget to the request so a hung host cannot spend 3 × 25 s of retries
      // past the 240 s adapter timeout (see the RUN_BUDGET_MS note above).
      const res = await ctx.http.json<SearchResultResponse>(url, {
        signal: AbortSignal.timeout(remainingMs),
      });
      offers = mapDerTours(res.tours ?? [], 'etravel', BASE_URL);
      successCount += 1;
    } catch (err) {
      if (err instanceof SourceBlockedError) {
        // Site is actively blocking us: stop issuing further destination queries (politeness) but
        // keep whatever offers earlier destinations already yielded. Record the block as lastError
        // so a block BEFORE the first success still trips the successCount===0 rethrow below.
        lastError = err;
        ctx.log(`etravel: ${country} blocked (${err.message}), stopping`);
        break;
      }
      // Per-request error isolation: one destination failing must not sink the others.
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      ctx.log(`etravel: ${country} query failed (${message}), skipping`);
      continue;
    }

    for (const offer of offers) {
      if (seen.has(offer.sourceOfferKey)) continue;
      seen.add(offer.sourceOfferKey);
      all.push(offer);
    }
  }

  if (successCount === 0 && lastError !== undefined) {
    // Every destination query failed (discovery was fine): this is not "market empty" — rethrow
    // (fischer pattern) so runScan records this source 'failed' rather than degrading to [] (which
    // would flip known offers inactive and mute the health alert). A block on the first destination
    // lands here → BLOCKED marker / 24h backoff engages. (Countries with no destination ids are a
    // benign skip, not a failure, so they never set lastError.)
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    ctx.log(`etravel: all destination queries failed (${message}), aborting`);
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  ctx.log(
    `etravel: fetched ${all.length} offers across ${successCount}/${TARGET_COUNTRIES.length} destinations ` +
      `(${requestCount} requests)`,
  );
  return all;
}

export const etravel: SourceAdapter = {
  name: 'etravel',
  fetchOffers,
};
