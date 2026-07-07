import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseInviaBoxes, decodeOfferJwt, invia } from '../src/sources/invia.js';
import { SourceBlockedError } from '../src/core/http.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const reckoFixtureRaw = readFileSync(join(__dirname, 'fixtures/invia/ajax-boxes.json'), 'utf-8');
const reckoFixture = JSON.parse(reckoFixtureRaw) as { customData: { boxes: string } };

const lastMinuteFixtureRaw = readFileSync(join(__dirname, 'fixtures/invia/ajax-boxes-lastminute.json'), 'utf-8');
const lastMinuteFixture = JSON.parse(lastMinuteFixtureRaw) as { customData: { boxes: string } };

function makeCtx(http: SourceContext['http']): SourceContext {
  return {
    http,
    adults: 2,
    log: vi.fn(),
  };
}

describe('decodeOfferJwt', () => {
  it('decodes the payload segment of a real s_offer_id JWT without verification', () => {
    // Captured from the first Řecko fixture card (Giakalis Aqua Park Resort).
    const jwt =
      'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJwcm92aWRlclByZWZpeCI6IklOVkYiLCJ0ZXJtSWQiOiI1MjcyMzMwMzgiLCJ0b3VyT3BlcmF0b3JJZCI6MjcsImNoZWNrSW5EYXRlIjoiMjAyNjEwMTEiLCJjaGVja091dERhdGUiOiIyMDI2MTAxOSIsImRheXNDb3VudCI6OSwiaG90ZWxJZCI6MjU3NjUsInRvdXJJZCI6MTMxNjIxNiwidHJhbnNwb3J0YXRpb25JZCI6MywiZGVwYXJ0dXJlQWlycG9ydCI6MSwibWVhbElkIjo1LCJjb3VudHJ5SWQiOjI4LCJsb2NhbGl0eUlkIjoxNDh9.sig';
    const payload = decodeOfferJwt(jwt);
    expect(payload).toBeDefined();
    expect(payload).not.toBeNull();
    expect(payload!.hotelId).toBe(25765);
    expect(payload!.termId).toBe('527233038');
    expect(payload!.checkInDate).toBe('20261011');
    expect(payload!.checkOutDate).toBe('20261019');
    expect(payload!.daysCount).toBe(9);
    expect(payload!.mealId).toBe(5);
    expect(payload!.transportationId).toBe(3);
    expect(payload!.departureAirport).toBe(1);
    expect(payload!.countryId).toBe(28);
  });

  it('returns null for garbage input instead of throwing', () => {
    expect(decodeOfferJwt('not-a-jwt')).toBeNull();
    expect(decodeOfferJwt('')).toBeNull();
    expect(decodeOfferJwt('a.b')).toBeNull();
    expect(decodeOfferJwt('a.!!!notbase64!!!.c')).toBeNull();
  });
});

describe('parseInviaBoxes: Řecko (nl_country_id=28) fixture', () => {
  const offers = parseInviaBoxes(reckoFixture, { country: 'Řecko' });

  it('parses the real card count from the fixture (boxesFound=16)', () => {
    expect(offers.length).toBe(16);
  });

  it('parses the first offer with real values from the fixture', () => {
    const first = offers[0];
    expect(first).toBeDefined();
    expect(first!.title).toBe('Giakalis Aqua Park Resort');
    expect(first!.country).toBe('Řecko');
    expect(first!.locality).toBe('Marmari');
    expect(first!.pricePerPerson).toBe(11890);
    expect(first!.departureDate).toBe('2026-10-11');
    expect(first!.nights).toBe(8); // checkOutDate 20261019 - checkInDate 20261011 = 8 days
    expect(first!.board).toBe('AI');
    expect(first!.transport).toBe('flight');
    expect(first!.departureAirport).toBe('PRG');
    expect(first!.tourOperator).toBe('blue_style_a_s');
    expect(first!.source).toBe('invia');
    expect(first!.url).toContain('https://www.invia.cz/hotel/recko/kos/giakalis-aqua-park-resort/');
    expect(first!.sourceOfferKey.length).toBeGreaterThan(0);
  });

  it('parses the discount badge "Sleva - 40%" into claimedDiscountPct + computed original price (House Kyriaki)', () => {
    const withDiscount = offers.find((o) => o.title === 'House Kyriaki');
    expect(withDiscount).toBeDefined();
    expect(withDiscount!.pricePerPerson).toBe(1713);
    expect(withDiscount!.claimedDiscountPct).toBe(40);
    expect(withDiscount!.claimedOriginalPrice).toBe(Math.round(1713 / (1 - 40 / 100)));
  });

  it('leaves claimedDiscountPct/claimedOriginalPrice null when there is no discount badge', () => {
    const first = offers[0];
    expect(first!.claimedDiscountPct).toBeNull();
    expect(first!.claimedOriginalPrice).toBeNull();
  });

  it('holds invariants for every offer', () => {
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(o.source).toBe('invia');
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(Number.isInteger(o.pricePerPerson)).toBe(true);
      expect(o.url.startsWith('https://www.invia.cz/')).toBe(true);
      expect(o.title.length).toBeGreaterThan(0);
      expect(o.sourceOfferKey.length).toBeGreaterThan(0);
      expect(o.country).toBe('Řecko');
      if (o.claimedDiscountPct !== null) {
        expect(o.claimedDiscountPct).toBeGreaterThan(0);
        expect(o.claimedDiscountPct).toBeLessThan(100);
      }
    }
  });

  it('deduplicates by sourceOfferKey', () => {
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('parseInviaBoxes: last-minute fixture (no country filter)', () => {
  const offers = parseInviaBoxes(lastMinuteFixture);

  it('parses the real card count (boxesFound=15)', () => {
    expect(offers.length).toBe(15);
  });

  it('derives country per-card from GA4 item_category_local when it is a recognized country', () => {
    // First card in this fixture is Italy (item_category_local="italie").
    const first = offers[0];
    expect(first!.country).toBe('Itálie');
  });

  it('holds invariants for every offer', () => {
    for (const o of offers) {
      expect(o.source).toBe('invia');
      expect(o.pricePerPerson).toBeGreaterThan(0);
      expect(o.url.startsWith('https://www.invia.cz/')).toBe(true);
    }
  });
});

/**
 * Builds a minimal synthetic `customData.boxes` HTML fragment for one card, matching exactly
 * the selectors parseCard/parseInviaBoxes rely on (h2 title, a[href*="s_offer_id="], the GA4
 * data-ga-click-data-value blob, [data-testid="price"], .b-product-list-2__location). Used to
 * exercise the GA4-slug country-fallback path in isolation. The JWTs below carry no countryId,
 * so resolution falls through to the GA4 item_category_local slug (query-2/last-minute style).
 */
function makeSyntheticBox(opts: { title: string; jwt: string; itemCategoryLocal: string; locationText: string }): {
  customData: { boxes: string };
} {
  const ga4 = {
    event: 'select_item',
    ecommerce: {
      items: [
        {
          item_name: opts.title,
          item_brand: 'Test Operator',
          item_category_local: opts.itemCategoryLocal,
          price: 12345,
          value: 12345,
          item_parameter_3: 'PRG',
        },
      ],
    },
  };
  const ga4Attr = JSON.stringify(ga4).replace(/"/g, '&quot;');
  const href = `https://www.invia.cz/hotel/test/test/?s_offer_id=${opts.jwt}`;
  const boxes = `
<article role="article" class="b-product-list-2">
  <div class="b-product-list-2__inner">
    <a href="${href}" data-ga-click-data-value="${ga4Attr}"><h2 class="h5">${opts.title}</h2></a>
    <p class="b-product-list-2__location">${opts.locationText}</p>
    <span class="price"><strong data-testid="price">123</strong> Kč za os.</span>
  </div>
</article>`;
  return { customData: { boxes } };
}

describe('parseInviaBoxes: synthetic GA4-slug country fallback (query-2 style, no countryId in JWT)', () => {
  // JWT payloads below deliberately omit countryId so resolution exercises the GA4-slug path.
  const noCountryIdJwt1 =
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ0ZXJtSWQiOiI5OTkiLCJob3RlbElkIjoxLCJjaGVja0luRGF0ZSI6IjIwMjYwOTAxIiwiY2hlY2tPdXREYXRlIjoiMjAyNjA5MDgiLCJkYXlzQ291bnQiOjcsIm1lYWxJZCI6NSwidHJhbnNwb3J0YXRpb25JZCI6M30.sig';
  const noCountryIdJwt2 =
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJ0ZXJtSWQiOiI5OTgiLCJob3RlbElkIjoyLCJjaGVja0luRGF0ZSI6IjIwMjYwOTAxIiwiY2hlY2tPdXREYXRlIjoiMjAyNjA5MDgiLCJkYXlzQ291bnQiOjcsIm1lYWxJZCI6NSwidHJhbnNwb3J0YXRpb25JZCI6M30.sig';

  it('slug "spanelsko pevnina" (non-canonical, resort-qualified) resolves to null country, never the raw slug', () => {
    const fixture = makeSyntheticBox({
      title: 'Test Hotel Spain',
      jwt: noCountryIdJwt1,
      itemCategoryLocal: 'spanelsko pevnina',
      locationText: 'Španělsko - Pevnina - Costa Brava',
    });
    const offers = parseInviaBoxes(fixture);
    expect(offers.length).toBe(1);
    expect(offers[0]!.country).toBeNull();
  });

  it('slug "italie" (canonical) resolves to "Itálie"', () => {
    const fixture = makeSyntheticBox({
      title: 'Test Hotel Italy',
      jwt: noCountryIdJwt2,
      itemCategoryLocal: 'italie',
      locationText: 'Itálie - Sardinie / Sardegna - Bari Sardo',
    });
    const offers = parseInviaBoxes(fixture);
    expect(offers.length).toBe(1);
    expect(offers[0]!.country).toBe('Itálie');
  });
});

describe('invia adapter fetchOffers', () => {
  it('queries twice (Řecko + last-minute) and merges deduped offers', async () => {
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce(reckoFixture)
      .mockResolvedValueOnce(lastMinuteFixture);
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);

    const offers = await invia.fetchOffers(ctx);

    expect(jsonMock).toHaveBeenCalledTimes(2);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.length).toBeLessThanOrEqual(16 + 15);
    for (const o of offers) {
      expect(o.source).toBe('invia');
    }
  });

  it('stops immediately when a query is blocked, keeping offers already collected', async () => {
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce(reckoFixture)
      .mockRejectedValueOnce(new SourceBlockedError(403));
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);

    const offers = await invia.fetchOffers(ctx);

    expect(offers.length).toBe(16);
  });

  it('continues past a generic per-query error without throwing', async () => {
    const jsonMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(lastMinuteFixture);
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);

    const offers = await invia.fetchOffers(ctx);

    expect(offers.length).toBe(15);
  });

  it('rethrows when the FIRST query is blocked before any success (backoff must engage)', async () => {
    const jsonMock = vi.fn().mockRejectedValue(new SourceBlockedError(403, 'blocked'));
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);
    await expect(invia.fetchOffers(ctx)).rejects.toThrow('blocked');
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });
});
