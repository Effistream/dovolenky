/**
 * Frontend mirror of the /api shapes committed in src/web/api.ts (Task 25).
 * Field names copied verbatim from that module's OfferItem / buildSources /
 * buildStats — do not rename without matching the server.
 */

/** Which baseline the real discount was measured against (null = collecting). */
export type Reference = 'own' | 'omnibus' | 'hotel' | 'locality' | 'market' | null;

/** A pricier cross-source twin of the representative offer. */
export interface Alternative {
  source: string;
  pricePerPerson: number;
  url: string;
}

/** One row of the board: the cheapest representative of a match-key group. */
export interface Offer {
  id: number;
  source: string;
  title: string;
  country: string | null;
  locality: string | null;
  stars: number | null;
  board: string;
  transport: string;
  departureAirport: string | null;
  departureDate: string | null;
  nights: number | null;
  pricePerPerson: number;
  priceTotal: number | null;
  claimedOriginalPrice: number | null;
  claimedDiscountPct: number | null;
  tourOperator: string | null;
  url: string;
  realPct: number | null;
  reference: Reference;
  baseline: number | null;
  fake: boolean;
  alternatives: Alternative[];
  sparkline: number[];
}

export interface OffersResponse {
  offers: Offer[];
}

/** Per-source status from the latest source_run, plus a 24h backoff flag. */
export interface SourceStatus {
  source: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  offersFound: number | null;
  snapshotsWritten: number | null;
  errorCount: number | null;
  errorSample: string | null;
  backoff: boolean;
}

export interface SourcesResponse {
  sources: SourceStatus[];
}

/** Market summary: active count, new-in-24h, and median latest price per profile. */
export interface StatsResponse {
  activeCount: number;
  new24h: number;
  medianByProfile: Record<string, number | null>;
}

/** The three profile filters shown as single-select chips (mockup order). */
export type ProfileFilter = 'all' | 'leto-more' | 'last-minute';

/** One price observation in an offer's history (oldest→newest). */
export interface HistoryPoint {
  /** ISO capture timestamp. */
  at: string;
  price: number;
}

/**
 * Price history for a single offer (GET /api/offers/:id/history). Field names
 * mirror src/web/api.ts#buildHistory verbatim: `series` uses `price` (not
 * pricePerPerson), `median` is the 30-day band centre, `claimedOriginalPrice`
 * is the latest seller-claimed "original" (drives the red dashed line).
 */
export interface HistoryResponse {
  offerId: number;
  title: string;
  series: HistoryPoint[];
  median: number | null;
  claimedOriginalPrice: number | null;
}
