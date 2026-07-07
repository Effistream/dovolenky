import { createHash } from 'node:crypto';
import type { Board, Transport, NormalizedOffer } from './types.js';

const strip = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function normalizeBoard(raw: string | null | undefined): Board {
  if (!raw) return 'unknown';
  const s = strip(raw);
  if (s.includes('all') && s.includes('inclusive')) return 'AI';
  if (s.includes('plna penze') || s === 'fb') return 'FB';
  if (s.includes('polopenze') || s === 'hb') return 'HB';
  if (s.includes('snidan') || s === 'bb') return 'BB';
  if (s.includes('bez strav')) return 'none';
  return 'unknown';
}

export function normalizeTransport(raw: string | null | undefined): Transport {
  if (!raw) return 'unknown';
  const s = strip(raw);
  if (s.includes('letec') || s.includes('flight')) return 'flight';
  if (s.includes('vlastni') || s.includes('own')) return 'own';
  if (s.includes('autobus') || s.includes('bus')) return 'bus';
  return 'unknown';
}

// Kanonické názvy zemí; klíč = stripped varianta/slug.
const COUNTRIES = ['Řecko','Turecko','Egypt','Španělsko','Kypr','Bulharsko','Chorvatsko','Itálie','Tunisko','Malta','Portugalsko','Albánie','Černá Hora','Maroko','Spojené arabské emiráty','Thajsko','Zanzibar','Kapverdy','Dominikánská republika','Mexiko','Kuba','Maledivy','Mauricius','Seychely','Srí Lanka','Indonésie','Vietnam','Madeira','Kanárské ostrovy','Slovinsko','Francie','Rakousko','Maďarsko','Slovensko','Česká republika','Gruzie','Jordánsko','Izrael','Omán','Katar','Polsko','Tanzanie','Keňa','Réunion','Filipíny','Kambodža','Nepál','Peru','Japonsko','Jihoafrická republika','Madagaskar','Namibie'];
const COUNTRY_BY_KEY = new Map(COUNTRIES.map(c => [strip(c), c]));
COUNTRY_BY_KEY.set('sae', 'Spojené arabské emiráty');
COUNTRY_BY_KEY.set('emiraty', 'Spojené arabské emiráty');
COUNTRY_BY_KEY.set('cerna hora', 'Černá Hora');
COUNTRY_BY_KEY.set('bali', 'Indonésie');
COUNTRY_BY_KEY.set('dominikana', 'Dominikánská republika');

export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(/[\/,–-]/)[0]?.trim() ?? '';
  if (!first) return null;
  const hit = COUNTRY_BY_KEY.get(strip(first));
  if (hit) return hit;
  // fallback: Title-case první token tak jak přišel
  return first;
}

/**
 * True iff `raw` resolves to a canonical country we actually recognize (i.e. its stripped
 * first token — same tokenization normalizeCountry uses: split on /[\/,–-]/, take the first
 * segment, strip diacritics/case — is a key in COUNTRY_BY_KEY). Does NOT change
 * normalizeCountry's own raw-passthrough fallback behavior; callers who need a strict
 * "canonical or null" result should gate normalizeCountry's return with this guard, e.g.
 * `isKnownCountry(raw) ? normalizeCountry(raw) : null`.
 */
export function isKnownCountry(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const first = raw.split(/[\/,–-]/)[0]?.trim() ?? '';
  if (!first) return false;
  return COUNTRY_BY_KEY.has(strip(first));
}

export function parseCzk(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = raw.replace(/[   ]/g, '').match(/(\d{3,})(?:Kč|CZK|$|[^\d])/);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseCzDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];
  const cz = raw.match(/(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/);
  if (!cz) return null;
  const [, d, mo, y] = cz;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function offerKeyHash(parts: (string | number | null | undefined)[]): string {
  return createHash('sha1').update(parts.map(p => String(p ?? '')).join('|')).digest('hex').slice(0, 16);
}

// Stopwords stripped from hotel/offer titles for cross-source name canonization
// (spec §13): generic lodging-type words and the "&"/"and" connective that
// differ across sources for the otherwise-same property, plus the star-rating
// glyph some sources append to the title.
const HOTEL_STOPWORDS = new Set(['hotel', 'resort', 'spa', 'aparthotel', 'apartments', 'wellness', 'and']);

/**
 * Canonical form of a hotel/offer title for cross-source matching (spec §13):
 * lowercase, diacritics stripped, "&"/star glyphs and generic lodging
 * stopwords removed, whitespace collapsed. Not meant to be human-readable —
 * only used as an input to computeMatchKey's hash.
 */
export function normalizeHotelName(raw: string): string {
  const s = strip(raw)
    .replace(/★/g, ' ')
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ');
  const tokens = s.split(/\s+/).filter(t => t.length > 0 && !HOTEL_STOPWORDS.has(t));
  return tokens.join(' ');
}

// City name / airport-code -> IATA lookup for cross-source matching (spec §13).
// Keys are `strip()`-ed (lowercase, no diacritics) so both Czech and non-Czech
// spellings of the city name resolve to the same code.
const AIRPORT_BY_KEY = new Map<string, string>([
  ['praha', 'PRG'],
  ['brno', 'BRQ'],
  ['ostrava', 'OSR'],
  ['pardubice', 'PED'],
  ['viden', 'VIE'],       // Vídeň
  ['bratislava', 'BTS'],
  ['budapest', 'BUD'],    // Budapešť (diacritics-stripped)
  ['katovice', 'KTW'],
  ['krakov', 'KRK'],
  ['wroclaw', 'WRO'],
]);

/**
 * Normalize a departure-airport city name or IATA code to its 3-letter IATA
 * code for cross-source matching (spec §13). Existing 3-letter codes pass
 * through uppercased; unrecognized input (including empty/nullish) -> null,
 * which computeMatchKey buckets under a literal '*' rather than merging with
 * genuinely different airports.
 */
export function normalizeAirport(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z]{3}$/.test(trimmed)) return trimmed.toUpperCase();
  const hit = AIRPORT_BY_KEY.get(strip(trimmed));
  return hit ?? null;
}

/**
 * Cross-source identity key for a normalized offer (spec §13): sha1 of
 * [canonName, country, departureDate, nights, board, airportNorm ?? '*'].
 * Lives here (rather than ingest.ts) because it only needs normalize.ts's own
 * helpers (normalizeHotelName, normalizeAirport, offerKeyHash) plus the
 * NormalizedOffer type — no dependency on db/ingest machinery, and it keeps
 * all offer-canonicalization logic in one module.
 *
 * Returns null — deliberately opting the offer out of cross-source matching —
 * when departureDate is null, board is 'unknown', country is null, or the
 * title normalizes to an empty canonical name (title was entirely stopwords,
 * e.g. "Hotel" or "Resort Spa"): any of these makes the offer under-specified
 * enough that a wrong merge (treating two different physical tours as the
 * same one) is a worse outcome than no merge at all. An empty canonName in
 * particular would make computeMatchKey degenerate to hashing just
 * [country, departureDate, nights, board, airportNorm], so any two unrelated
 * properties sharing those fields would incorrectly collide.
 */
export function computeMatchKey(o: NormalizedOffer): string | null {
  if (o.departureDate === null || o.board === 'unknown' || o.country === null) return null;
  const canonName = normalizeHotelName(o.title);
  if (canonName === '') return null;
  const airportNorm = normalizeAirport(o.departureAirport);
  return offerKeyHash([canonName, o.country, o.departureDate, o.nights, o.board, airportNorm ?? '*']);
}

/**
 * Cross-term, cross-source identity key for a HOTEL (spec §15), one level up from
 * computeMatchKey: sha1 of [canonName, country] only — no date/nights/board/airport — so every
 * term of the same physical property (any length of stay, any departure date, any source) shares
 * the same hotel_key. Used by the discount-v2 "hotel" reference rung to pool a hotel's own other
 * terms as a per-night baseline.
 *
 * Same null-conservatism as computeMatchKey: returns null (never a false grouping) when the title
 * normalizes to an empty canonical name (all-stopword title, e.g. "Hotel" or "Resort Spa") or when
 * country is null — either makes the offer under-specified enough that a wrong merge (pooling two
 * unrelated properties) is worse than no merge at all.
 */
export function computeHotelKey(o: NormalizedOffer): string | null {
  const canonName = normalizeHotelName(o.title);
  if (canonName === '' || o.country === null) return null;
  return offerKeyHash([canonName, o.country]);
}
