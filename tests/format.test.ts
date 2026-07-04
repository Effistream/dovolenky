import { describe, it, expect } from 'vitest';
import { escapeHtml, formatOffer, formatDigest } from '../src/core/format.js';
import type { NormalizedOffer } from '../src/core/types.js';
import type { DiscountResult } from '../src/core/discount.js';

function offer(overrides: Partial<NormalizedOffer> = {}): NormalizedOffer {
  return {
    source: 'fischer',
    sourceOfferKey: 'abc123',
    title: 'Hotel Peniscola Plaza',
    country: 'Španělsko',
    locality: 'Peñíscola',
    stars: 4,
    board: 'AI',
    transport: 'flight',
    departureAirport: 'Praha',
    departureDate: '2026-07-15',
    nights: 7,
    pricePerPerson: 16990,
    priceTotal: null,
    claimedOriginalPrice: null,
    claimedDiscountPct: 45,
    omnibusLowestPrice: null,
    tourOperator: 'Fischer',
    url: 'https://example.com/offer/abc123',
    ...overrides,
  };
}

// DiscountResult.realPct is positive when the price is genuinely below the
// baseline (e.g. 22 = 22 % cheaper), matching src/core/discount.ts's
// convention (see tests/discount.test.ts).
function discount(overrides: Partial<DiscountResult> = {}): DiscountResult {
  return {
    realPct: 22,
    reference: 'own',
    baseline: 21800,
    fake: false,
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes <, >, and &', () => {
    expect(escapeHtml('<b>Tom & Jerry</b>')).toBe('&lt;b&gt;Tom &amp; Jerry&lt;/b&gt;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeHtml('Hotel Peniscola Plaza')).toBe('Hotel Peniscola Plaza');
  });

  it('escapes " and \' (attribute-safe)', () => {
    expect(escapeHtml(`say "hi" and 'bye'`)).toBe('say &quot;hi&quot; and &#39;bye&#39;');
  });

  it('a scraped URL containing " renders a well-formed <a href> with no raw quote inside the attribute', () => {
    const maliciousUrl = 'https://example.com/offer?x="><script>alert(1)</script>';
    const msg = formatOffer('hot_deal', offer({ url: maliciousUrl }), discount());

    const hrefMatch = /<a href="([^"]*)">odkaz<\/a>/.exec(msg);
    expect(hrefMatch).not.toBeNull();
    // the captured attribute value must not contain a raw, unescaped quote
    expect(hrefMatch![1]).not.toContain('"');
    expect(hrefMatch![1]).toContain('&quot;');
    expect(msg).not.toContain('<script>');
  });
});

describe('formatOffer', () => {
  it('hot_deal: uses the 🔥 emoji', () => {
    const msg = formatOffer('hot_deal', offer(), discount());
    expect(msg.startsWith('🔥')).toBe(true);
  });

  it('price_drop: uses the 📉 emoji', () => {
    const msg = formatOffer('price_drop', offer(), discount(), { previousPrice: 19000 });
    expect(msg.startsWith('📉')).toBe(true);
  });

  it('new_offer: uses the 🆕 emoji', () => {
    const msg = formatOffer('new_offer', offer(), discount());
    expect(msg.startsWith('🆕')).toBe(true);
  });

  it('escapes the title', () => {
    const msg = formatOffer('hot_deal', offer({ title: '<script>Hotel</script> & Spa' }), discount());
    expect(msg).toContain('&lt;script&gt;Hotel&lt;/script&gt; &amp; Spa');
    expect(msg).not.toContain('<script>Hotel</script>');
  });

  it('escapes country/locality and departure airport (scraped free text)', () => {
    const msg = formatOffer(
      'hot_deal',
      offer({ country: 'Špa<n>ělsko', locality: 'Pe & ñíscola', departureAirport: 'Praha <VIE>' }),
      discount(),
    );
    expect(msg).toContain('Špa&lt;n&gt;ělsko');
    expect(msg).toContain('Pe &amp; ñíscola');
    expect(msg).toContain('Praha &lt;VIE&gt;');
    expect(msg).not.toContain('<n>');
    expect(msg).not.toContain('<VIE>');
  });

  it('renders stars as repeated ★ characters', () => {
    const msg = formatOffer('hot_deal', offer({ stars: 4 }), discount());
    expect(msg).toContain('★★★★');
  });

  it('omits stars when stars is null', () => {
    const msg = formatOffer('hot_deal', offer({ stars: null }), discount());
    expect(msg).not.toContain('★');
  });

  it('formats price as "16 990 Kč/os." with regular spaces (cs-CZ, nbsp replaced)', () => {
    const msg = formatOffer('hot_deal', offer({ pricePerPerson: 16990 }), discount());
    expect(msg).toContain('16 990 Kč/os.');
    // no non-breaking space characters anywhere in the price line
    expect(msg).not.toContain(' ');
  });

  it('includes the real-discount line with the "own" reference label when realPct is set', () => {
    const msg = formatOffer('hot_deal', offer(), discount({ realPct: 22, reference: 'own', baseline: 21800 }));
    expect(msg).toContain('30denní medián');
    expect(msg).toContain('21 800 Kč');
    expect(msg).toContain('22');
  });

  it('uses the "omnibus" reference label', () => {
    const msg = formatOffer('hot_deal', offer(), discount({ realPct: 10, reference: 'omnibus', baseline: 18000 }));
    expect(msg).toContain('zákonné 30denní minimum');
  });

  it('uses the "market" reference label', () => {
    const msg = formatOffer('hot_deal', offer(), discount({ realPct: 10, reference: 'market', baseline: 18000 }));
    expect(msg).toContain('medián trhu');
  });

  it('falls back to "sbírám historii" when realPct is null', () => {
    const msg = formatOffer('hot_deal', offer(), discount({ realPct: null, reference: null, baseline: null }));
    expect(msg).toContain('reálná sleva: sbírám historii');
  });

  it('shows ⚠️ and "nadsazená sleva" only when fake is true', () => {
    const fakeMsg = formatOffer('hot_deal', offer(), discount({ fake: true }));
    expect(fakeMsg).toContain('⚠️');
    expect(fakeMsg).toContain('nadsazená sleva');

    const realMsg = formatOffer('hot_deal', offer(), discount({ fake: false }));
    expect(realMsg).not.toContain('⚠️');
    expect(realMsg).not.toContain('nadsazená sleva');
  });

  it('price_drop includes a "↓ z 15 000 Kč" line built from extra.previousPrice', () => {
    const msg = formatOffer('price_drop', offer(), discount(), { previousPrice: 15000 });
    expect(msg).toContain('↓ z 15 000 Kč');
  });

  it('hot_deal and new_offer do not include the "↓ z" line even if previousPrice is passed', () => {
    const msg = formatOffer('hot_deal', offer(), discount(), { previousPrice: 15000 });
    expect(msg).not.toContain('↓ z');
  });

  it('renders the departure date in Czech DD.MM.YYYY format with the nights suffix', () => {
    const msg = formatOffer('hot_deal', offer({ departureDate: '2026-07-15', nights: 7 }), discount());
    expect(msg).toContain('🗓 15.07.2026 (7 nocí)');
    expect(msg).not.toContain('2026-07-15');
  });

  it('renders the source URL as an HTML anchor', () => {
    const msg = formatOffer('hot_deal', offer({ url: 'https://example.com/offer/abc123' }), discount());
    expect(msg).toContain('<a href="https://example.com/offer/abc123">');
  });

  it('includes the tour operator / source name', () => {
    const msg = formatOffer('hot_deal', offer({ tourOperator: 'Fischer' }), discount());
    expect(msg).toContain('Fischer');
  });

  it('does not contain exclamation marks (stop-slop rule)', () => {
    const msg = formatOffer('hot_deal', offer(), discount({ fake: true }));
    expect(msg).not.toContain('!');
  });
});

describe('formatDigest', () => {
  it('caps the digest at 10 items even if more are passed', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      offer: offer({ title: `Hotel ${i}`, url: `https://example.com/${i}` }),
      d: discount({ realPct: i + 1 }),
    }));
    const msg = formatDigest(items, { activeOffers: 120, newLast24h: 8 });

    for (let i = 0; i < 10; i += 1) {
      expect(msg).toContain(`Hotel ${i}`);
    }
    for (let i = 10; i < 15; i += 1) {
      expect(msg).not.toContain(`Hotel ${i}`);
    }
  });

  it('starts with the ☀️ digest emoji', () => {
    const msg = formatDigest([{ offer: offer(), d: discount() }], { activeOffers: 1, newLast24h: 0 });
    expect(msg.startsWith('☀️')).toBe(true);
  });

  it('includes a stats footer with active offers and new-in-24h counts', () => {
    const msg = formatDigest([{ offer: offer(), d: discount() }], { activeOffers: 42, newLast24h: 5 });
    expect(msg).toContain('42');
    expect(msg).toContain('5');
  });

  it('escapes titles of each item', () => {
    const items = [{ offer: offer({ title: '<b>Bad</b>' }), d: discount() }];
    const msg = formatDigest(items, { activeOffers: 1, newLast24h: 0 });
    expect(msg).toContain('&lt;b&gt;Bad&lt;/b&gt;');
    expect(msg).not.toContain('<b>Bad</b>');
  });

  it('handles an empty items list without throwing', () => {
    const msg = formatDigest([], { activeOffers: 0, newLast24h: 0 });
    expect(msg.startsWith('☀️')).toBe(true);
    expect(msg).toContain('0');
  });

  it('a normal small digest is unchanged (no overflow line)', () => {
    const items = [
      { offer: offer(), d: discount() },
      { offer: offer({ title: 'Hotel Second' }), d: discount() },
    ];
    const msg = formatDigest(items, { activeOffers: 10, newLast24h: 2 });
    expect(msg).not.toContain('a dalších');
  });

  it('caps total message length at 3800 + short tail when 10 items have long titles/URLs, and reports the correct overflow count', () => {
    const marker = (i: number) => `UNIQUEMARK${i}END`;
    const items = Array.from({ length: 10 }, (_, i) => ({
      offer: offer({
        title: `${marker(i)} Velmi dlouhý název hotelu s spoustou detailů a marketingových frází`.repeat(3),
        url: `https://example.com/very/long/path/segment/that/keeps/going/${'x'.repeat(200)}/${i}`,
      }),
      d: discount({ realPct: i + 1 }),
    }));

    const msg = formatDigest(items, { activeOffers: 500, newLast24h: 50 });

    // message must stay within the 3800 safety margin plus a short tail
    // (the overflow line + stats footer)
    expect(msg.length).toBeLessThanOrEqual(3800 + 200);

    const renderedCount = items.filter((_, i) => msg.includes(marker(i))).length;
    const notRendered = items.length - renderedCount;
    expect(notRendered).toBeGreaterThan(0);

    const overflowMatch = /a dalších (\d+) nabídek/.exec(msg);
    expect(overflowMatch).not.toBeNull();
    expect(Number(overflowMatch![1])).toBe(notRendered);
  });
});
