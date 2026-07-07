export type Board = 'AI' | 'FB' | 'HB' | 'BB' | 'none' | 'unknown';
export type Transport = 'flight' | 'own' | 'bus' | 'unknown';

export interface NormalizedOffer {
  source: string;
  sourceOfferKey: string;
  title: string;
  country: string | null;
  locality: string | null;
  stars: number | null;
  board: Board;
  transport: Transport;
  departureAirport: string | null;
  departureDate: string | null; // ISO YYYY-MM-DD
  nights: number | null;
  pricePerPerson: number;       // CZK, integer
  priceTotal: number | null;
  claimedOriginalPrice: number | null;
  claimedDiscountPct: number | null;
  omnibusLowestPrice: number | null;
  tourOperator: string | null;
  url: string;
}

import type { HttpClient } from './http.js';

export interface SourceContext {
  http: HttpClient;
  adults: number;               // z config scan.adults
  log: (msg: string) => void;
  /**
   * Optional map of sourceOfferKey -> last known non-placeholder title for THIS source, loaded
   * by run.ts from the DB before each adapter's fetchOffers call (2026-07-07 fix). Lets an
   * adapter skip re-resolving a hotel/property name it already knows from a previous run instead
   * of spending a slot in its per-run resolution cap (see dovolenkovani.ts). Optional so existing
   * adapters/tests that don't use it are unaffected.
   */
  priorTitles?: Map<string, string>;
}

export interface SourceAdapter {
  name: string;
  fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]>;
}
