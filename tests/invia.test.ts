import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseInviaBoxes, decodeOfferJwt, termDatesFromParams, invia } from '../src/sources/invia.js';
import { SourceBlockedError } from '../src/core/http.js';
import { offerKeyHash } from '../src/core/normalize.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): { customData: { boxes: string; searchProps?: Record<string, unknown> } } {
  return JSON.parse(readFileSync(join(__dirname, `fixtures/invia/${name}.json`), 'utf-8')) as {
    customData: { boxes: string; searchProps?: Record<string, unknown> };
  };
}

const reckoFixture = loadFixture('ajax-boxes');
const lastMinuteFixture = loadFixture('ajax-boxes-lastminute');
// Trimmed 4-card capture of the Itálie query (nl_country_id=[22]) taken live on 2026-07-29 with the
// current, sort-free body. Chosen because those four cards are the ones the older Řecko/last-minute
// fixtures do NOT cover: mealId 1 (Plná penze) and 12 (Light All inclusive), a pipe-joined
// multi-airport card, and a card with no "X dní / Y nocí" label at all.
const italieFixture = loadFixture('ajax-boxes-italie');
// Three cards from the live Egypt query (nl_country_id=[11]) on 2026-07-29, one per inventory
// provider: INVF (Invia's own) alongside TTF and TUI (resold). Invia's own terms carry
// checkInDate/checkOutDate + termId in the s_offer_id JWT; the resold ones carry dateFrom/dateTo +
// offerId instead (TUI sends termId: null explicitly). Reading only the Invia-native spelling left
// departureDate null on 273 of 458 offers in a full live run.
const resoldFixture = loadFixture('ajax-boxes-resold-providers');

/**
 * The full run's request budget. src/core/run.ts aborts fetchOffers at 240 s and HttpClient spaces
 * same-host requests by 3 s, so the plan must stay well under ~50 requests. These numbers are
 * asserted so that adding a country (or a page) forces a deliberate re-check of the budget rather
 * than silently pushing the adapter over the timeout, which would drop the source from the board.
 */
const PLANNED_REQUESTS = 32; // a 2-page last-minute query + 24 countries, 6 of them 2-page
const MAX_REQUESTS = 34;

function makeCtx(http: SourceContext['http']): SourceContext {
  return {
    http,
    adults: 2,
    log: vi.fn(),
  };
}

/** Bodies of every POST the adapter issued, in order. */
function postedBodies(jsonMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return jsonMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>);
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
    expect(first!.board).toBe('AI');
    expect(first!.transport).toBe('flight');
    expect(first!.departureAirport).toBe('PRG');
    expect(first!.tourOperator).toBe('blue_style_a_s');
    expect(first!.source).toBe('invia');
    expect(first!.url).toContain('https://www.invia.cz/hotel/recko/kos/giakalis-aqua-park-resort/');
    expect(first!.sourceOfferKey.length).toBeGreaterThan(0);
  });

  it('takes nights from the card label, not the JWT trip span (Giakalis: "9 dní / 7 nocí")', () => {
    // JWT checkIn 20261011 / checkOut 20261019 spans 8 days because the outbound flight leaves on
    // the evening of the 11th; Invia sells and advertises 7 hotel nights.
    const first = offers[0];
    expect(first!.nights).toBe(7);
  });

  it('populates stars from the card (previously hardcoded null), 0 stars meaning "unknown" -> null', () => {
    expect(offers[0]!.stars).toBe(3.5); // Giakalis, GA4 item_parameter_4 "s:_3.5_r:_4.1_…"
    const unrated = offers.find((o) => o.title === 'Apartmány Jorgos');
    expect(unrated).toBeDefined();
    expect(unrated!.stars).toBeNull(); // "s:_0_…" — Invia's "unknown", not a zero-star hotel
  });

  it('populates priceTotal from the "za všechny" price block (previously hardcoded null)', () => {
    const first = offers[0];
    expect(first!.priceTotal).toBe(23780);
    expect(first!.priceTotal).toBe(first!.pricePerPerson * 2);
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
      if (o.priceTotal !== null) expect(o.priceTotal).toBeGreaterThanOrEqual(o.pricePerPerson);
      if (o.stars !== null) {
        expect(o.stars).toBeGreaterThan(0);
        expect(o.stars).toBeLessThanOrEqual(5);
      }
      // Never a pipe-joined multi-airport string — departureAirport is one airport or null.
      if (o.departureAirport !== null) expect(o.departureAirport).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('deduplicates by sourceOfferKey', () => {
    const keys = offers.map((o) => o.sourceOfferKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('parseInviaBoxes: Itálie fixture (2026-07-29 capture, field mapping)', () => {
  const offers = parseInviaBoxes(italieFixture, { country: 'Itálie' });

  it('parses all four cards', () => {
    expect(offers.length).toBe(4);
    expect(offers.map((o) => o.title)).toEqual([
      'Village Club Santa Caterina',
      'Maritim Resort Calabria',
      'Futura Club Colostrai',
      'Marco Polo',
    ]);
  });

  it('maps boards Invia\'s mealId table alone would miss, by reading the card label', () => {
    // mealId 1 "Plná penze", 12 "Light All inclusive", 2 "Polopenze" — none of which the v1
    // adapter's {4,5,6} map knew, so they all used to come out 'unknown'.
    expect(offers[0]!.board).toBe('FB');
    expect(offers[2]!.board).toBe('AI');
    expect(offers[3]!.board).toBe('HB');
  });

  it('collapses a multi-airport card to the Czech departure it offers', () => {
    // Maritim Resort Calabria advertises "PRG|BRQ|BTS" (Praha, Brno, Bratislava).
    expect(offers[1]!.departureAirport).toBe('PRG');
    expect(offers[1]!.transport).toBe('flight');
  });

  it('leaves departureAirport null on own-transport cards', () => {
    expect(offers[0]!.transport).toBe('own');
    expect(offers[0]!.departureAirport).toBeNull();
  });

  it('reads stars, priceTotal and the discount badge off every card', () => {
    expect(offers.map((o) => o.stars)).toEqual([4, 5, 4, 3]);
    expect(offers[1]!.pricePerPerson).toBe(21490);
    expect(offers[1]!.priceTotal).toBe(42980);
    expect(offers[2]!.claimedDiscountPct).toBe(51);
  });

  it('falls back to the JWT term span when the card carries no nights label (Marco Polo)', () => {
    expect(offers[3]!.nights).toBe(6);
    expect(offers[0]!.nights).toBe(7); // this one does have "8 dní / 7 nocí"
  });
});

describe('termDatesFromParams (rendered-term fallback for unknown providers)', () => {
  it('reads "ne 11.10. - po 19.10.2026", taking the year from the end of the range', () => {
    expect(termDatesFromParams(['9 dní / 7 nocí', 'ne 11.10. - po 19.10.2026', 'All Inclusive'])).toEqual({
      from: '20261011',
      to: '20261019',
    });
  });

  it('puts the start in the PREVIOUS year when the term crosses New Year', () => {
    // Only the end of the range carries a year, so a start month later than the end month is the
    // one and only signal that the term rolled over.
    expect(termDatesFromParams(['čt 31.12. - st 6.1.2027'])).toEqual({ from: '20261231', to: '20270106' });
  });

  it('returns null when no param looks like a term', () => {
    expect(termDatesFromParams(['8 dní', 'Vlastní', 'Bez stravy'])).toBeNull();
    expect(termDatesFromParams([])).toBeNull();
  });
});

describe('parseInviaBoxes: resold-inventory JWT shapes (TTF / TUI vs Invia-native)', () => {
  const offers = parseInviaBoxes(resoldFixture, { country: 'Egypt' });

  /** The three cards' JWT payloads, in card order. Each card repeats its s_offer_id across several
   * links and analytics blobs, so dedupe while preserving first-seen order. */
  const payloads = [
    ...new Set([...resoldFixture.customData.boxes.matchAll(/s_offer_id=([\w-]+\.[\w-]+\.[\w-]+)/g)].map((m) => m[1]!)),
  ]
    .map((j) => decodeOfferJwt(j))
    .filter((p): p is Record<string, unknown> => p !== null);

  it('the fixture really does contain the two different JWT shapes (guards the test below)', () => {
    // Without this the departureDate assertions could pass vacuously on Invia-native cards.
    expect(payloads.length).toBe(3);
    expect(payloads.filter((p) => p.checkInDate !== undefined).length).toBe(1); // INVF
    const resold = payloads.filter((p) => p.checkInDate === undefined);
    expect(resold.length).toBe(2); // TTF + TUI
    for (const p of resold) {
      expect(p.dateFrom).toMatch(/^\d{8}$/);
      expect(p.termId ?? null).toBeNull(); // TTF omits it, TUI sends null
      expect(typeof p.offerId).toBe('string');
    }
  });

  it('populates departureDate for EVERY card regardless of provider', () => {
    expect(offers.length).toBe(3);
    expect(offers.map((o) => o.departureDate)).toEqual(['2026-08-28', '2027-01-23', '2026-12-10']);
    // A null departureDate is not cosmetic: filters.ts drops such an offer from every profile with
    // departure_months (leto-more) or departure_within_days (last-minute — the only notifying
    // profile), and market.ts returns no price peers for it, so the discount ladder cannot run.
    expect(offers.filter((o) => o.departureDate === null).length).toBe(0);
  });

  it('keys resold terms off offerId, so hotelId+nights alone cannot decide identity', () => {
    expect(new Set(offers.map((o) => o.sourceOfferKey)).size).toBe(3);
    // The real point: the resold term id must actually PARTICIPATE in the hash. Before the fix a
    // resold card had neither termId nor departureDate, so its key degenerated to hotelId+nights —
    // two different terms at the same hotel with the same length then hashed identically and the
    // dedup in parseInviaBoxes silently dropped one. Pin the formula rather than just asserting
    // three keys are distinct (which three different hotels satisfy no matter what we hash).
    for (const [i, o] of offers.entries()) {
      const p = payloads[i]!;
      const termId = (p.termId ?? p.offerId ?? null) as string | null;
      expect(termId).not.toBeNull();
      expect(o.sourceOfferKey).toBe(offerKeyHash([p.hotelId as number, termId, o.departureDate, o.nights]));
    }
    // ...and the degenerate key the old formula produced for a resold card is not what we emit.
    const shoni = offers[1]!;
    expect(shoni.sourceOfferKey).not.toBe(offerKeyHash([payloads[1]!.hotelId as number, null, null, shoni.nights]));
  });

  it('still fills the rest of the fields on resold cards', () => {
    for (const o of offers) {
      expect(o.nights).toBeGreaterThan(0);
      expect(o.board).not.toBe('unknown');
      expect(o.transport).not.toBe('unknown');
      expect(o.priceTotal).not.toBeNull();
      expect(o.stars).not.toBeNull();
    }
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
 * so resolution falls through to the GA4 item_category_local slug (last-minute style).
 */
function makeSyntheticBox(opts: {
  title: string;
  jwt: string;
  itemCategoryLocal: string;
  locationText: string;
  /** Optional `.tour-params__item` strip (nights / transport / term / board / operator). */
  params?: string[];
}): {
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
    <ul class="tour-params">${(opts.params ?? [])
      .map((p) => `<li class="tour-params__item">${p}</li>`)
      .join('')}</ul>
    <span class="price"><strong data-testid="price">123</strong> Kč za os.</span>
  </div>
</article>`;
  return { customData: { boxes } };
}

describe('parseInviaBoxes: term-text date fallback for a provider whose JWT has neither date spelling', () => {
  // Invia resells inventory from several providers and each spells the term dates differently
  // (checkInDate/checkOutDate, or dateFrom/dateTo). This payload has NEITHER — the case a new
  // provider would present — so the only remaining source is the card's rendered term strip.
  const noJwtDatesJwt =
    'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJwcm92aWRlclByZWZpeCI6IlhZWiIsIm9mZmVySWQiOiJGVVRVUkUtUFJPVklERVItMSIsImhvdGVsSWQiOjksImRheXNDb3VudCI6OCwibWVhbElkIjo1LCJ0cmFuc3BvcnRhdGlvbklkIjozfQ.sig';

  it('recovers departureDate from the rendered term instead of emitting null', () => {
    const fixture = makeSyntheticBox({
      title: 'Test Hotel Future Provider',
      jwt: noJwtDatesJwt,
      itemCategoryLocal: 'italie',
      locationText: 'Itálie - Kalábrie - Tropea',
      params: ['8 dní / 7 nocí', 'Praha Lamezia Terme Zobrazit letový plán', 'po 14.9. - po 21.9.2026', 'All Inclusive'],
    });
    const offers = parseInviaBoxes(fixture);
    expect(offers.length).toBe(1);
    expect(offers[0]!.departureDate).toBe('2026-09-14');
    expect(offers[0]!.nights).toBe(7);
  });

  it('still emits a null departureDate when neither the JWT nor the card carries a term', () => {
    // The fallback must not invent a date out of the "8 dní" text or today's clock.
    const fixture = makeSyntheticBox({
      title: 'Test Hotel No Dates Anywhere',
      jwt: noJwtDatesJwt,
      itemCategoryLocal: 'italie',
      locationText: 'Itálie - Kalábrie - Tropea',
      params: ['8 dní', 'Vlastní', 'All Inclusive'],
    });
    const offers = parseInviaBoxes(fixture);
    expect(offers.length).toBe(1);
    expect(offers[0]!.departureDate).toBeNull();
    expect(offers[0]!.nights).toBe(7); // daysCount 8 - 1, the last-resort chain
  });
});

describe('parseInviaBoxes: synthetic GA4-slug country fallback (last-minute style, no countryId in JWT)', () => {
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

describe('invia adapter: query plan and request budget', () => {
  it(`issues exactly ${PLANNED_REQUESTS} requests and never more than the ${MAX_REQUESTS} cap`, async () => {
    // Every response claims another page is available, so nothing but the plan itself (and the
    // MAX_REQUESTS cap behind it) can stop the loop.
    const jsonMock = vi.fn().mockResolvedValue(reckoFixture);
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);

    await invia.fetchOffers(ctx);

    expect(jsonMock).toHaveBeenCalledTimes(PLANNED_REQUESTS);
    expect(jsonMock.mock.calls.length).toBeLessThanOrEqual(MAX_REQUESTS);
  });

  it('never sorts cheapest-first — that sort plus page-1-only capped the adapter at the bottom of the catalogue', async () => {
    const jsonMock = vi.fn().mockResolvedValue(reckoFixture);
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);

    await invia.fetchOffers(ctx);

    for (const body of postedBodies(jsonMock)) {
      expect(body.sort).toBeUndefined();
      expect(body.sort_order).toBeUndefined();
    }
  });

  it('applies the 7-14 night filter and a today-onwards departure window to EVERY query', async () => {
    const jsonMock = vi.fn().mockResolvedValue(reckoFixture);
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);

    await invia.fetchOffers(ctx);

    for (const body of postedBodies(jsonMock)) {
      // Omitting this pair on the last-minute query is what used to turn it into 1-night city
      // hotel rooms; s_holiday_target does not restrict the result set to packages.
      expect(body.nl_length_from).toBe(7);
      expect(body.nl_length_to).toBe(14);
      expect(body.d_start_from).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    }
  });

  it('queries the verified country ids and one country-agnostic last-minute window', async () => {
    const jsonMock = vi.fn().mockResolvedValue(reckoFixture);
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);

    await invia.fetchOffers(ctx);

    const bodies = postedBodies(jsonMock);
    const countryIds = new Set(bodies.flatMap((b) => (b.nl_country_id as number[] | undefined) ?? []));
    // Spot-check the ids read off the site's own /dovolena/<slug>/ landing pages on 2026-07-29.
    for (const id of [28, 31, 11, 30, 9, 29, 13, 79, 12, 73]) {
      expect(countryIds.has(id)).toBe(true);
    }
    const lastMinute = bodies.filter((b) => b.d_start_to !== undefined);
    expect(lastMinute.length).toBe(2); // one query, two pages
    for (const b of lastMinute) expect(b.nl_country_id).toBeUndefined();
    // It must run first: it is the only query feeding a notify_new_offers profile, so a truncated
    // run has to drop countries off the tail, never this.
    expect(bodies[0]!.d_start_to).toBeDefined();
    expect(bodies[1]!.d_start_to).toBeDefined();
  });
});

describe('invia adapter: pagination via the searchProps.offsets cursor', () => {
  const page1 = {
    customData: {
      boxes: reckoFixture.customData.boxes,
      searchProps: { isNextPageAvailable: true, offsets: 'hotel:240894214;itemsPerPage:15;boxesFound:16' },
    },
  };
  const noNextPage = {
    customData: { boxes: reckoFixture.customData.boxes, searchProps: { isNextPageAvailable: false } },
  };

  it('replays the same body with the previous response\'s cursor on page 2', async () => {
    const jsonMock = vi.fn().mockResolvedValue(page1);
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);

    await invia.fetchOffers(ctx);

    const bodies = postedBodies(jsonMock);
    expect(bodies[0]!.offsets).toBeUndefined();
    expect(bodies[1]!.offsets).toBe('hotel:240894214;itemsPerPage:15;boxesFound:16');
    // Same country, same filters — only the cursor differs.
    expect(bodies[1]!.nl_country_id).toEqual(bodies[0]!.nl_country_id);
    expect(bodies[1]!.nl_length_from).toBe(bodies[0]!.nl_length_from);
  });

  it('stops paginating a country as soon as isNextPageAvailable is false', async () => {
    const jsonMock = vi.fn().mockResolvedValue(noNextPage);
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);

    await invia.fetchOffers(ctx);

    // One request per query instead of the planned 33 pages: 24 countries + last-minute.
    expect(jsonMock).toHaveBeenCalledTimes(25);
  });
});

describe('invia adapter fetchOffers: error contract', () => {
  it('merges deduped offers across queries', async () => {
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce(reckoFixture)
      .mockResolvedValueOnce(lastMinuteFixture)
      .mockResolvedValue({ customData: { boxes: '' } });
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);

    const offers = await invia.fetchOffers(ctx);

    expect(offers.length).toBe(16 + 15);
    expect(new Set(offers.map((o) => o.sourceOfferKey)).size).toBe(offers.length);
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
    expect(jsonMock).toHaveBeenCalledTimes(2); // no further requests after the block
  });

  it('continues past a generic per-query error without throwing', async () => {
    const jsonMock = vi.fn().mockRejectedValueOnce(new Error('network blip')).mockResolvedValue(lastMinuteFixture);
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);

    const offers = await invia.fetchOffers(ctx);

    expect(offers.length).toBe(15);
    // The failed page-1 leaves no cursor, so that country's page 2 is skipped, not retried.
    expect(jsonMock).toHaveBeenCalledTimes(PLANNED_REQUESTS - 1);
  });

  it('rethrows when EVERY request fails (runScan must record "failed", not an empty source)', async () => {
    const jsonMock = vi.fn().mockRejectedValue(new Error('network down'));
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);

    await expect(invia.fetchOffers(ctx)).rejects.toThrow('network down');
  });

  it('rethrows when the FIRST query is blocked before any success (backoff must engage)', async () => {
    const jsonMock = vi.fn().mockRejectedValue(new SourceBlockedError(403, 'blocked'));
    const ctx = makeCtx({ json: jsonMock, text: vi.fn() } as unknown as SourceContext['http']);
    await expect(invia.fetchOffers(ctx)).rejects.toThrow('blocked');
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });
});
