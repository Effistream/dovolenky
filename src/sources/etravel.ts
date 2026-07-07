import type { NormalizedOffer, SourceAdapter, SourceContext } from '../core/types.js';
import { mapDerTours } from './der.js';

const BASE_URL = 'https://www.etravel.cz';
const WINDOW_DAYS = 60;
const NIGHTS = '7|8|9|10|11|12|13|14';
// A TARGET country only produces offers if `discoverDestinationIds` (the categories response of
// `getsearchresult?tt=1`) returns a `destinations[]` entry whose `name` matches exactly and whose
// `destinationIds` is non-empty; otherwise it is gracefully skipped ("no destination ids found").
// Exotic names (spec §16.2) live-verified 2026-07-07 (Chrome UA) directly against that categories
// response — all 9 below were present with a non-empty destinationIds string (e.g. Maledivy=220441,
// Mauricius=63738, Srí Lanka=64077, Kuba=222769, SAE/Thajsko/Mexiko/Vietnam multi-region). Zanzibar
// was deliberately NOT added: it is not a country-level category on eTravel (rolled into Tanzánie),
// so it would only ever skip; its exotic inventory is covered by Datour/FIRO/eximtours instead.
const TARGET_COUNTRIES = [
  'Řecko',
  'Turecko',
  'Egypt',
  'Spojené arabské emiráty',
  'Maledivy',
  'Thajsko',
  'Dominikánská republika',
  'Mauricius',
  'Kuba',
  'Mexiko',
  'Srí Lanka',
  'Vietnam',
];

/**
 * eTravel runs on the DER Touristik platform (shared with Fischer/Exim — see der.ts) and is
 * the only source in this project whose API surfaces an official Omnibus 30-day-minimum price
 * (`tour.price.lowestPrice`), so it's the reference source for that field.
 *
 * Destination IDs are NOT the country-level ids from `getfilter`'s `geo.sdo` (`type: "st"`,
 * e.g. Řecko=63064): passing that id alone into `getsearchresult`'s `d=` param yields
 * `toursCount: 0` — confirmed live. The API instead expects a `|`-joined list of the
 * finer-grained region ids that belong to that country. The easiest reliable way to get that
 * list is calling `getsearchresult` itself with NO `d` filter (just `tt=1`): it then returns
 * `resultType: "categories"` with `categories[].destinations[]`, each carrying
 * `{ id, name, destinationIds }` — `destinationIds` is exactly the pipe-joined region-id string
 * to feed back into a real `d=` query for that country. So `fetchOffers` does one categories
 * discovery request, then one getsearchresult request per target country (4 requests total).
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
  });
  return `${BASE_URL}/api/searchapi/getsearchresult?${params.toString()}`;
}

async function fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]> {
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

  for (const country of TARGET_COUNTRIES) {
    const ids = destinationIds.get(country);
    if (!ids) {
      ctx.log(`etravel: no destination ids found for ${country}, skipping`);
      continue;
    }

    let offers: NormalizedOffer[];
    try {
      const url = searchUrl(ids, today);
      const res = await ctx.http.json<SearchResultResponse>(url);
      offers = mapDerTours(res.tours ?? [], 'etravel', BASE_URL);
    } catch (err) {
      // Per-request error isolation: one destination failing must not sink the others.
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

  ctx.log(`etravel: fetched ${all.length} offers across ${TARGET_COUNTRIES.length} destinations`);
  return all;
}

export const etravel: SourceAdapter = {
  name: 'etravel',
  fetchOffers,
};
