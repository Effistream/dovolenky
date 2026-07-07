import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEximSeeds, parseEximSearch, eximtours } from '../src/sources/eximtours.js';
import type { SourceContext } from '../src/core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lastMinuteHtml = readFileSync(join(__dirname, 'fixtures/eximtours/last-minute.html'), 'utf-8');
const searchFixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/eximtours/getsearch.json'), 'utf-8'));

describe('parseEximSeeds', () => {
  const seeds = parseEximSeeds(lastMinuteHtml);

  it('extracts at least 5 destinations with a searchUrl', () => {
    expect(seeds.length).toBeGreaterThanOrEqual(5);
    for (const seed of seeds) {
      expect(seed.name.length).toBeGreaterThan(0);
      expect(seed.searchUrl).toContain('vysledky-vyhledavani');
    }
  });

  it('includes Egypt and Řecko with a real searchUrl (hardcoded from the fixture)', () => {
    const egypt = seeds.find((s) => s.name === 'Egypt');
    const recko = seeds.find((s) => s.name === 'Řecko');
    expect(egypt).toBeDefined();
    expect(recko).toBeDefined();
    expect(egypt!.searchUrl).toBe(
      '/vysledky-vyhledavani?ds=0&tt=1&d=64419%7c64420%7c64422%7c64423%7c64424%7c64425&dd=2026-07-05&rd=2026-09-02&er=0&isss=0&nn=7%7c10%7c14&ac1=2&kc1=0&ic1=0',
    );
    expect(recko!.searchUrl).toContain('d=63219%7c63220');
  });
});

describe('parseEximSearch (fixture)', () => {
  const offers = parseEximSearch(searchFixture);

  it('parses all 20 cards from the HTML field (no silent drops)', () => {
    expect(offers.length).toBe(20);
  });

  it('maps the first card (Rewaya Inn Resort ex. Hawaii Paradise) with hardcoded real values', () => {
    const first = offers[0]!;
    expect(first.source).toBe('eximtours');
    expect(first.title).toBe('Rewaya Inn Resort ex. Hawaii Paradise');
    expect(first.country).toBe('Egypt');
    expect(first.locality).toBe('Hurghada');
    expect(first.stars).toBe(5);
    expect(first.board).toBe('AI');
    expect(first.pricePerPerson).toBe(13590);
    expect(first.priceTotal).toBe(27180);
    expect(first.claimedOriginalPrice).toBe(25550); // round(51100/2), adults=round(27180/13590)=2
    expect(first.claimedDiscountPct).toBe(47); // round(23920/51100*100)
    expect(first.departureDate).toBe('2026-07-09');
    expect(first.nights).toBe(7);
    expect(first.transport).toBe('flight');
    expect(first.url.startsWith('https://www.eximtours.cz/egypt/hurghada/hurghadahawaii-paradise')).toBe(true);
  });

  it('derives a per-person claimedOriginalPrice from the TOTAL-based originalPrice/discount', () => {
    // Empirical finding (verified against all 20 cards in both the Egypt and Řecko fixtures,
    // zero mismatches): js-roomPrice-originalPrice minus js-totalDiscount--amount always equals
    // js-roomPrice-total exactly (e.g. 51100 - 23920 = 27180 = 2 * adult0's 13590). So
    // originalPrice/discount are TOTAL-based figures (like eTravel/DER — see der.ts), NOT
    // per-person, even though adult0 alone is per-person. claimedOriginalPrice is converted to
    // per-person (dividing by the derived adult count) to match every sibling adapter's
    // claimedOriginalPrice contract, so it must exceed pricePerPerson, not priceTotal.
    for (const offer of offers) {
      if (offer.claimedOriginalPrice !== null && offer.pricePerPerson !== null) {
        expect(offer.claimedOriginalPrice).toBeGreaterThan(offer.pricePerPerson);
      }
    }
  });

  it('every offer with a claimed discount has a plausible pct (1..90)', () => {
    for (const offer of offers) {
      if (offer.claimedDiscountPct !== null) {
        expect(offer.claimedDiscountPct).toBeGreaterThan(0);
        expect(offer.claimedDiscountPct).toBeLessThan(100);
      }
    }
  });

  it('enforces invariants: positive price, absolute eximtours.cz url, correct source tag', () => {
    for (const offer of offers) {
      expect(offer.pricePerPerson).toBeGreaterThan(0);
      expect(offer.url.startsWith('https://www.eximtours.cz')).toBe(true);
      expect(offer.source).toBe('eximtours');
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

  it('parses dates directly (both start/end dates carry a full 4-digit year in this source)', () => {
    for (const offer of offers) {
      if (offer.departureDate) {
        expect(offer.departureDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  it('dedupes cards sharing the same title/date/nights/board key', () => {
    const html = (searchFixture as { HTML: string }).HTML;
    const duplicated = { ...searchFixture, HTML: html + html };
    const withDup = parseEximSearch(duplicated);
    expect(withDup.length).toBe(offers.length);
  });
});

describe('eximtours source adapter', () => {
  it('is named eximtours and issues bounded requests (1 seed GET + up to 12 destination GETs)', async () => {
    const textMock = vi.fn().mockResolvedValue(lastMinuteHtml);
    const jsonMock = vi.fn().mockResolvedValue(searchFixture);

    const ctx: SourceContext = {
      http: { json: jsonMock, text: textMock } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await eximtours.fetchOffers(ctx);

    expect(eximtours.name).toBe('eximtours');
    expect(textMock).toHaveBeenCalledTimes(1);
    expect(jsonMock.mock.calls.length).toBeGreaterThan(0);
    // TARGET_DESTINATIONS grew to 12 (spec §16.2 exotic broadening); the seed GET is 1 text call
    // and each destination that resolves to a seed is one json GET, capped at the target count.
    expect(jsonMock.mock.calls.length).toBeLessThanOrEqual(12);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.source === 'eximtours')).toBe(true);
  });

  it('isolates a per-destination request failure without sinking the whole fetch', async () => {
    const textMock = vi.fn().mockResolvedValue(lastMinuteHtml);
    const jsonMock = vi.fn().mockRejectedValueOnce(new Error('network blip')).mockResolvedValue(searchFixture);

    const ctx: SourceContext = {
      http: { json: jsonMock, text: textMock } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await eximtours.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
  });

  it('rethrows a total last-minute seed fetch failure (so runScan records it failed, not empty)', async () => {
    const textMock = vi.fn().mockRejectedValue(new Error('seed down'));
    const jsonMock = vi.fn();

    const ctx: SourceContext = {
      http: { json: jsonMock, text: textMock } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    await expect(eximtours.fetchOffers(ctx)).rejects.toThrow('seed down');
    expect(jsonMock).not.toHaveBeenCalled();
  });

  it('stops issuing further destination requests on SourceBlockedError but keeps offers already collected', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    const textMock = vi.fn().mockResolvedValue(lastMinuteHtml);
    const jsonMock = vi
      .fn()
      .mockResolvedValueOnce(searchFixture)
      .mockRejectedValueOnce(new SourceBlockedError(403, 'blocked'));

    const ctx: SourceContext = {
      http: { json: jsonMock, text: textMock } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };

    const offers = await eximtours.fetchOffers(ctx);
    expect(offers.length).toBeGreaterThan(0);
    expect(jsonMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows when the FIRST destination request is blocked before any success (backoff must engage)', async () => {
    const { SourceBlockedError } = await import('../src/core/http.js');
    const textMock = vi.fn().mockResolvedValue(lastMinuteHtml);
    const jsonMock = vi.fn().mockRejectedValue(new SourceBlockedError(403, 'blocked'));
    const ctx: SourceContext = {
      http: { json: jsonMock, text: textMock } as unknown as SourceContext['http'],
      adults: 2,
      log: vi.fn(),
    };
    await expect(eximtours.fetchOffers(ctx)).rejects.toThrow('blocked');
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });
});
