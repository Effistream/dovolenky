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
}

export interface SourceAdapter {
  name: string;
  fetchOffers(ctx: SourceContext): Promise<NormalizedOffer[]>;
}
