import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExclusionFieldset, addExclusion, removeExclusion } from './FilterBar.js';
import type { Offer } from '../lib/types.js';

// The board's collapse toggle is React state, and this suite has no DOM/event
// environment (node vitest, like Board.test.ts). So the „Nechci vidět" UI is
// extracted into ExclusionFieldset (rendered ungated) which we render to static
// markup for structure, and the add/remove list mutations are pure exported
// helpers we exercise directly — the same value the chip/select handlers pass to
// onExcluded.
function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: 1,
    source: 'invia',
    title: 'Hotel',
    country: 'Řecko',
    locality: 'Kréta',
    stars: 4,
    board: 'AI',
    transport: 'flight',
    departureAirport: 'PRG',
    departureDate: '2026-08-15',
    nights: 7,
    pricePerPerson: 12000,
    priceTotal: 24000,
    claimedOriginalPrice: null,
    claimedDiscountPct: null,
    tourOperator: null,
    url: 'https://x/1',
    realPct: 20,
    reference: 'market',
    baseline: 15000,
    fake: false,
    alternatives: [],
    sparkline: [],
    ...over,
  };
}

// Board still carries an already-excluded country (Egypt) in the loaded set —
// the picker filters it out, but its chip is still shown.
const offers = [offer({ id: 1, country: 'Řecko' }), offer({ id: 2, country: 'Egypt' })];

describe('ExclusionFieldset', () => {
  it('renders a removable chip for each excluded country', () => {
    const html = renderToStaticMarkup(
      createElement(ExclusionFieldset, { offers, excluded: ['Egypt'], onExcluded: () => {} }),
    );
    expect(html).toContain('Egypt ✕'); // removable chip label
    expect(html).toContain('aria-pressed="true"'); // active-chip styling hook
    expect(html).toContain('Zrušit vyloučení'); // remove affordance (title)
  });

  it('add-picker lists board countries except already-excluded ones', () => {
    const html = renderToStaticMarkup(
      createElement(ExclusionFieldset, { offers, excluded: ['Egypt'], onExcluded: () => {} }),
    );
    expect(html).toContain('Řecko (1)'); // Řecko is a selectable <option>
    expect(html).not.toContain('Egypt (1)'); // Egypt is excluded → not in the picker
  });

  it('offers every board country when nothing is excluded', () => {
    const html = renderToStaticMarkup(
      createElement(ExclusionFieldset, { offers, excluded: [], onExcluded: () => {} }),
    );
    expect(html).toContain('Řecko (1)');
    expect(html).toContain('Egypt (1)');
    expect(html).not.toContain('✕'); // no chips when nothing excluded
  });
});

describe('exclusion list helpers', () => {
  it('removeExclusion drops the country (removing the last one → [])', () => {
    expect(removeExclusion(['Egypt'], 'Egypt')).toEqual([]);
    expect(removeExclusion(['Egypt', 'Řecko'], 'Egypt')).toEqual(['Řecko']);
  });

  it('addExclusion appends without duplicating', () => {
    expect(addExclusion(['Egypt'], 'Řecko')).toEqual(['Egypt', 'Řecko']);
    expect(addExclusion(['Egypt'], 'Egypt')).toEqual(['Egypt']);
  });
});
