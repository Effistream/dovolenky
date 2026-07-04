import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseFischerHydration, mapFischerHotels, fischer } from '../src/sources/fischer.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lastMinuteHtml = readFileSync(join(__dirname, 'fixtures/fischer/last-minute.html'), 'utf-8');
const hotelListFixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/fischer/getTourHotelList.json'), 'utf-8'),
);

describe('parseFischerHydration', () => {
  const { documentGuid, tours } = parseFischerHydration(lastMinuteHtml);

  it('extracts a documentGuid', () => {
    expect(documentGuid).toBe('04af28e1-df72-4dc0-894e-6548566d67dc');
  });

  it('extracts at least one tour', () => {
    expect(tours.length).toBeGreaterThan(0);
  });

  it('the first tour carries real hydration values', () => {
    const first = tours[0] as {
      id: number;
      searchFilter: string;
      departureDate: string;
      location: { country: string; destination: string };
      departureLocation: string;
      nightsCount: { from: number; to: number };
      adultPriceFrom: { amount: number };
    };
    expect(first.id).toBe(-468797491);
    expect(first.searchFilter).toBe(
      'DS=0&TT=1&TO=4312&D=63244&DD=2026-07-06&RD=2026-07-13&ER=0&ISSS=0&NN=7&PF=0&AC1=2&KC1=0&IC1=0&QF=109_1_0&ILM=1',
    );
    expect(first.departureDate).toBe('2026-07-06T00:00:00');
    expect(first.location.country).toBe('Španělsko');
    expect(first.location.destination).toBe('Costa del Azahar');
    expect(first.departureLocation).toBe('Praha');
    expect(first.nightsCount).toEqual({ from: 7, to: 7 });
    expect(first.adultPriceFrom.amount).toBe(16990);
  });
});

describe('mapFischerHotels (fixture)', () => {
  const tourMeta = {
    departureDate: '2026-07-06',
    nights: 7,
    country: 'Řecko',
    locality: 'Chalkidiki a Olympská Riviéra',
  };
  const offers = mapFischerHotels(hotelListFixture.hotels, tourMeta);

  it('maps every hotel in the fixture (no silent drops)', () => {
    expect(hotelListFixture.hotels.length).toBe(5);
    expect(offers.length).toBe(5);
  });

  it('maps the first hotel (Mendi Beach and Garden hotel) with hardcoded real values', () => {
    const first = offers[0]!;
    expect(first.source).toBe('fischer');
    expect(first.title).toBe('Mendi Beach and Garden hotel');
    expect(first.stars).toBe(4);
    expect(first.board).toBe('HB'); // Polopenze
    expect(first.pricePerPerson).toBe(15990);
    expect(first.nights).toBe(7);
    expect(first.departureDate).toBe('2026-07-06');
    expect(first.country).toBe('Řecko');
    expect(first.locality).toBe('Chalkidiki a Olympská Riviéra');
    expect(first.transport).toBe('flight');
    expect(first.url).toBe(
      'https://www.fischer.cz/recko/chalkidiki-olympska-riviera/elia-nikiti/mendi-beach-and-garden-hotel?DS=256&GIATA=503&D=63281&HID=4326&PF=0&MT=2&DI=HB&RCS=DR03&NN=7&MNN=7&NNM=7&DF=2026-07-06%7C2026-07-13&RD=2026-07-13&DD=2026-07-06&ERM=0&AC1=2&KC1=0&IC1=0&TO=4312&TT=1&MS=10&PID=SKG90001&DPR=FISCHER+ATCOM&ILM=1&PC=8748757%2F2%2F2378%2F7&IFC=143441210%2F505059&OFC=143440153%2F505058',
    );
    expect(first.claimedOriginalPrice).toBeNull();
    expect(first.claimedDiscountPct).toBeNull();
    expect(first.omnibusLowestPrice).toBeNull();
    expect(first.tourOperator).toBeNull();
  });

  it('maps meal -> board across the variety in the fixture', () => {
    const byName = new Map(offers.map((o) => [o.title, o]));
    expect(byName.get('Villa Dio')!.board).toBe('none'); // Bez stravování
    expect(byName.get('Apolamare Hotel')!.board).toBe('HB'); // Polopenze
    expect(byName.get('ELINOTEL SERMILIA RESORT')!.board).toBe('AI'); // All Inclusive Ultra
  });

  it('maps stars from rating.count, including 0 stars', () => {
    const byName = new Map(offers.map((o) => [o.title, o]));
    expect(byName.get('Villa Dio')!.stars).toBe(0);
    expect(byName.get('ELINOTEL SERMILIA RESORT')!.stars).toBe(5);
  });

  it('enforces invariants: positive price, absolute fischer.cz url, correct source tag', () => {
    for (const offer of offers) {
      expect(offer.pricePerPerson).toBeGreaterThan(0);
      expect(offer.url.startsWith('https://www.fischer.cz')).toBe(true);
      expect(offer.source).toBe('fischer');
      expect(offer.sourceOfferKey.length).toBeGreaterThan(0);
    }
  });

  it('produces a canonical country or null, never a locality/city value', () => {
    for (const offer of offers) {
      expect(offer.country === null || typeof offer.country === 'string').toBe(true);
      if (offer.country !== null) {
        expect(offer.country).not.toBe(offer.locality);
      }
    }
  });

  it('falls back to null country for an unrecognized/garbled location', () => {
    const offers2 = mapFischerHotels(hotelListFixture.hotels.slice(0, 1), {
      departureDate: '2026-07-06',
      nights: 7,
      country: 'Nesmyslná Zeme Xyz',
      locality: 'Nekde',
    });
    expect(offers2[0]!.country).toBeNull();
  });

  it('dedupes hotels sharing the same hotelId/date/nights/board key', () => {
    const duplicated = [...hotelListFixture.hotels, hotelListFixture.hotels[0]];
    const withDup = mapFischerHotels(duplicated, tourMeta);
    expect(withDup.length).toBe(offers.length);
  });
});

/** Builds a minimal synthetic /last-minute page carrying the given tours in the hydration blob,
 *  matching the real wrapper shape (`toursSearchSettings.documentGuid` + `tourListResult.tours`). */
function buildHydrationHtml(tours: unknown[]): string {
  const payload = {
    toursSearchSettings: { documentGuid: 'synthetic-guid' },
    tourListResult: { tours },
  };
  return `<html><body><section><div data-component-name="appTourList"><script type="application/json">${JSON.stringify(
    payload,
  )}</script></div></section></body></html>`;
}

function makeSyntheticTour(overrides: Record<string, unknown>) {
  return {
    id: 1,
    searchFilter: 'DS=0&TT=1',
    departureDate: '2026-07-06T00:00:00',
    location: { country: 'Řecko', destination: 'Chalkidiki' },
    departureLocation: 'Praha',
    nightsCount: { from: 7, to: 7 },
    adultPriceFrom: { amount: 10000 },
    ...overrides,
  };
}

describe('fischer source adapter', () => {
  it('collapses a nightsCount {from,to} range to the minimum stay (from) when from !== to', async () => {
    const tour = makeSyntheticTour({ id: 999, nightsCount: { from: 7, to: 14 } });
    const html = buildHydrationHtml([tour]);
    const textMock = vi.fn().mockResolvedValue(html);
    const jsonMock = vi.fn().mockResolvedValue({ hotels: [hotelListFixture.hotels[0]] });

    const ctx: SourceContext = {
      http: { json: jsonMock, text: textMock } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await fischer.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers[0]!.nights).toBe(7);
  });

  it('sorts tours by departureDate ascending before taking the top MAX_TOURS, regardless of server order', async () => {
    // Shuffled input order: [id 3 (07-20), id 1 (null date), id 2 (07-10)]. Expected processing
    // order after the adapter's own sort: id 2 (07-10, earliest) -> id 3 (07-20) -> id 1 (null,
    // sorts last). This proves selection isn't relying on server-side order.
    const tourFar = makeSyntheticTour({
      id: 3,
      searchFilter: 'tour-far',
      departureDate: '2026-07-20T00:00:00',
      location: { country: 'Řecko', destination: 'C' },
    });
    const tourNullDate = makeSyntheticTour({
      id: 1,
      searchFilter: 'tour-null-date',
      departureDate: null,
      location: { country: 'Řecko', destination: 'A' },
    });
    const tourNear = makeSyntheticTour({
      id: 2,
      searchFilter: 'tour-near',
      departureDate: '2026-07-10T00:00:00',
      location: { country: 'Řecko', destination: 'B' },
    });
    const tours = [tourFar, tourNullDate, tourNear];
    const html = buildHydrationHtml(tours);
    const textMock = vi.fn().mockResolvedValue(html);
    const jsonMock = vi.fn().mockResolvedValue({ hotels: [hotelListFixture.hotels[0]] });

    const ctx: SourceContext = {
      http: { json: jsonMock, text: textMock } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    await fischer.fetchOffers(ctx);

    // The adapter must request getTourHotelList in departureDate-ascending order (earliest
    // first, null-departureDate tour last) rather than in the raw/shuffled input order.
    const requestedSearchFilters = jsonMock.mock.calls.map((call) => {
      const opts = call[1] as { body: string };
      return JSON.parse(opts.body).searchFilter as string;
    });
    expect(jsonMock).toHaveBeenCalledTimes(3);
    expect(requestedSearchFilters).toEqual(['tour-near', 'tour-far', 'tour-null-date']);
  });
});

describe('fischer source adapter (fixture-backed)', () => {
  it('is named fischer and issues bounded requests (1 page + up to N tour POSTs)', async () => {
    const textMock = vi.fn().mockResolvedValue(lastMinuteHtml);
    const jsonMock = vi.fn().mockResolvedValue(hotelListFixture);

    const ctx: SourceContext = {
      http: { json: jsonMock, text: textMock } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await fischer.fetchOffers(ctx);

    expect(fischer.name).toBe('fischer');
    expect(textMock).toHaveBeenCalledTimes(1);
    expect(jsonMock.mock.calls.length).toBeGreaterThan(0);
    expect(jsonMock.mock.calls.length).toBeLessThanOrEqual(10);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.source === 'fischer')).toBe(true);
  });

  it('isolates a per-tour POST failure without sinking the whole fetch', async () => {
    const textMock = vi.fn().mockResolvedValue(lastMinuteHtml);
    const jsonMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValue(hotelListFixture);

    const ctx: SourceContext = {
      http: { json: jsonMock, text: textMock } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await fischer.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
  });

  it('stops on SourceBlockedError but keeps offers already collected', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    const textMock = vi.fn().mockResolvedValue(lastMinuteHtml);
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce(hotelListFixture)
      .mockRejectedValueOnce(new SourceBlockedError(403, 'blocked'));

    const ctx: SourceContext = {
      http: { json: jsonMock, text: textMock } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await fischer.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    expect(jsonMock).toHaveBeenCalledTimes(2);
  });
});
