import { describe, it, expect } from 'vitest';
import { normalizeBoard, normalizeTransport, normalizeCountry, isKnownCountry, parseCzk, parseCzDate, offerKeyHash, normalizeHotelName, normalizeAirport, computeMatchKey, computeHotelKey } from '../src/core/normalize.js';
import type { NormalizedOffer } from '../src/core/types.js';

function makeOffer(overrides: Partial<NormalizedOffer> = {}): NormalizedOffer {
  return {
    source: 'invia',
    sourceOfferKey: 'hotel-x-2026-07-15',
    title: 'Blue Aegean Resort & Spa',
    country: 'Řecko',
    locality: 'Kréta',
    stars: 4,
    board: 'AI',
    transport: 'flight',
    departureAirport: 'Praha',
    departureDate: '2026-07-15',
    nights: 7,
    pricePerPerson: 16781,
    priceTotal: 33562,
    claimedOriginalPrice: 20000,
    claimedDiscountPct: 16.1,
    omnibusLowestPrice: 15000,
    tourOperator: 'Invia',
    url: 'https://example.com/offer',
    ...overrides,
  };
}

describe('normalize', () => {
  it('board', () => {
    expect(normalizeBoard('All inclusive')).toBe('AI');
    expect(normalizeBoard('all-inclusive')).toBe('AI');
    expect(normalizeBoard('Ultra All Inclusive')).toBe('AI');
    expect(normalizeBoard('Polopenze')).toBe('HB');
    expect(normalizeBoard('Snídaně')).toBe('BB');
    expect(normalizeBoard('Plná penze')).toBe('FB');
    expect(normalizeBoard('Bez stravy')).toBe('none');
    expect(normalizeBoard(null)).toBe('unknown');
  });
  it('transport', () => {
    expect(normalizeTransport('Letecky')).toBe('flight');
    expect(normalizeTransport('letecky-praha')).toBe('flight');
    expect(normalizeTransport('Vlastní doprava')).toBe('own');
    expect(normalizeTransport('Autobusem')).toBe('bus');
    expect(normalizeTransport(undefined)).toBe('unknown');
  });
  it('country', () => {
    expect(normalizeCountry('Řecko')).toBe('Řecko');
    expect(normalizeCountry('recko')).toBe('Řecko');
    expect(normalizeCountry('Egypt / Hurghada')).toBe('Egypt');
    expect(normalizeCountry('Albánie, Vlora')).toBe('Albánie');
    expect(normalizeCountry('chorvatsko')).toBe('Chorvatsko');
    expect(normalizeCountry('')).toBeNull();
    // Polsko was added as a recognized destination (see isKnownCountry tests below).
    expect(normalizeCountry('polsko')).toBe('Polsko');
  });
  it('isKnownCountry', () => {
    expect(isKnownCountry('recko')).toBe(true);
    // Polsko is now a recognized canonical country (added to COUNTRIES).
    expect(isKnownCountry('polsko')).toBe(true);
    // "spanelsko pevnina" is not a canonical country key (it's a resort/region qualifier
    // glued to the country name) — must be rejected, never leaked as a raw string.
    expect(isKnownCountry('spanelsko pevnina')).toBe(false);
    // Same tokenization as normalizeCountry: split on /[\/,–-]/ takes only the first segment
    // *before* the hyphen, so "kanarske-ostrovy" reduces to "kanarske" alone, which is not a
    // COUNTRY_BY_KEY key (the real key is "kanarske ostrovy", space-separated) — documenting
    // this literal (if perhaps surprising) behavior rather than special-casing hyphenated
    // country names.
    expect(isKnownCountry('kanarske-ostrovy')).toBe(false);
    expect(isKnownCountry('')).toBe(false);
    expect(isKnownCountry(null)).toBe(false);
    expect(isKnownCountry(undefined)).toBe(false);
    expect(isKnownCountry('totally-unknown-place')).toBe(false);
  });
  it('parseCzk', () => {
    expect(parseCzk(' 16 781 Kč')).toBe(16781);
    expect(parseCzk('od 7 990 Kč')).toBe(7990);
    expect(parseCzk('75 100 Kč')).toBe(75100);
    expect(parseCzk('nesmysl')).toBeNull();
  });
  it('parseCzDate', () => {
    expect(parseCzDate('15.07.2026')).toBe('2026-07-15');
    expect(parseCzDate('15. 7. 2026')).toBe('2026-07-15');
    expect(parseCzDate('2026-07-15')).toBe('2026-07-15');
    expect(parseCzDate('blbost')).toBeNull();
  });
  it('offerKeyHash stable', () => {
    const a = offerKeyHash(['Hotel X', '2026-07-15', 7, 'AI']);
    expect(a).toBe(offerKeyHash(['Hotel X', '2026-07-15', 7, 'AI']));
    expect(a).not.toBe(offerKeyHash(['Hotel Y', '2026-07-15', 7, 'AI']));
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });
  it('normalizeHotelName', () => {
    expect(normalizeHotelName('Blue Aegean Resort & Spa')).toBe('blue aegean');
    expect(normalizeHotelName('HOTEL Seaden Corolla ★★★★★')).toBe('seaden corolla');
    expect(normalizeHotelName('Wellness Hotel Vista')).toBe('vista');
    expect(normalizeHotelName('Jelení Dvůr')).toBe('jeleni dvur');
  });
  it('normalizeAirport', () => {
    expect(normalizeAirport('Praha')).toBe('PRG');
    expect(normalizeAirport('PRG')).toBe('PRG');
    expect(normalizeAirport('prg')).toBe('PRG');
    expect(normalizeAirport('Vídeň')).toBe('VIE');
    expect(normalizeAirport('Neznámé Město')).toBeNull();
    expect(normalizeAirport(null)).toBeNull();
    expect(normalizeAirport(undefined)).toBeNull();
  });
  it('computeMatchKey: same canonical fields across sources -> same key', () => {
    const invia = makeOffer({ source: 'invia', sourceOfferKey: 'invia-1', title: 'Blue Aegean Resort & Spa' });
    const dovolenkovani = makeOffer({
      source: 'dovolenkovani',
      sourceOfferKey: 'dov-1',
      title: 'HOTEL Blue Aegean ★★★★',
      departureAirport: 'PRG',
    });
    const keyA = computeMatchKey(invia);
    const keyB = computeMatchKey(dovolenkovani);
    expect(keyA).not.toBeNull();
    expect(keyA).toBe(keyB);
  });
  it('computeMatchKey: board unknown -> null', () => {
    expect(computeMatchKey(makeOffer({ board: 'unknown' }))).toBeNull();
  });
  it('computeMatchKey: departureDate null -> null', () => {
    expect(computeMatchKey(makeOffer({ departureDate: null }))).toBeNull();
  });
  it('computeMatchKey: country null -> null', () => {
    expect(computeMatchKey(makeOffer({ country: null }))).toBeNull();
  });
  it('computeMatchKey: different airport -> different key', () => {
    const prg = computeMatchKey(makeOffer({ departureAirport: 'Praha' }));
    const brq = computeMatchKey(makeOffer({ departureAirport: 'Brno' }));
    expect(prg).not.toBeNull();
    expect(brq).not.toBeNull();
    expect(prg).not.toBe(brq);
  });
  it('computeMatchKey: airport null vs PRG -> different key (null buckets under *)', () => {
    const nullAirport = computeMatchKey(makeOffer({ departureAirport: null }));
    const prg = computeMatchKey(makeOffer({ departureAirport: 'PRG' }));
    expect(nullAirport).not.toBeNull();
    expect(prg).not.toBeNull();
    expect(nullAirport).not.toBe(prg);
  });
  it('computeMatchKey: title normalizes to empty canonName -> null (never a false cross-source merge)', () => {
    // 'Hotel' and 'Resort Spa' both normalize to '' (all-stopword titles).
    // Without the empty-canonName guard these would hash to IDENTICAL keys
    // for two unrelated properties sharing country/date/nights/board/airport.
    const keyHotel = computeMatchKey(makeOffer({ title: 'Hotel' }));
    const keyResortSpa = computeMatchKey(makeOffer({ title: 'Resort Spa' }));
    expect(keyHotel).toBeNull();
    expect(keyResortSpa).toBeNull();
    // Both are null, not equal-but-identical hash strings — i.e. these two unrelated
    // properties are correctly opted OUT of matching rather than falsely merged.

    // A normal, non-stopword-only title still yields a real key.
    const keyNormal = computeMatchKey(makeOffer({ title: 'Blue Aegean Resort & Spa' }));
    expect(keyNormal).not.toBeNull();
  });
  it('computeHotelKey: same hotel, different dates/nights -> same hotel_key, different match_key', () => {
    const termA = makeOffer({ departureDate: '2026-07-15', nights: 7 });
    const termB = makeOffer({ departureDate: '2026-08-01', nights: 10 });

    const hotelKeyA = computeHotelKey(termA);
    const hotelKeyB = computeHotelKey(termB);
    expect(hotelKeyA).not.toBeNull();
    expect(hotelKeyA).toBe(hotelKeyB);

    const matchKeyA = computeMatchKey(termA);
    const matchKeyB = computeMatchKey(termB);
    expect(matchKeyA).not.toBe(matchKeyB);
  });
  it('computeHotelKey: empty/all-stopword title -> null', () => {
    expect(computeHotelKey(makeOffer({ title: 'Hotel' }))).toBeNull();
    expect(computeHotelKey(makeOffer({ title: 'Resort Spa' }))).toBeNull();
  });
  it('computeHotelKey: null country -> null', () => {
    expect(computeHotelKey(makeOffer({ country: null }))).toBeNull();
  });
  it('computeHotelKey: same name, different country -> different key', () => {
    const greece = computeHotelKey(makeOffer({ country: 'Řecko' }));
    const turkey = computeHotelKey(makeOffer({ country: 'Turecko' }));
    expect(greece).not.toBeNull();
    expect(turkey).not.toBeNull();
    expect(greece).not.toBe(turkey);
  });
});
