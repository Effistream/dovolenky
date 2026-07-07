import { describe, it, expect } from 'vitest';
import { sortCaption } from './Board.js';

// The board caption must reflect the active sort, not hardcode "REÁLNÁ SLEVY"
// regardless of state (a prior bug). Covers all three SortKey values.
describe('sortCaption', () => {
  it('real → "SEŘAZENO PODLE REÁLNÉ SLEVY"', () => {
    expect(sortCaption('real')).toBe('SEŘAZENO PODLE REÁLNÉ SLEVY');
  });
  it('price → "SEŘAZENO PODLE CENY"', () => {
    expect(sortCaption('price')).toBe('SEŘAZENO PODLE CENY');
  });
  it('departure → "SEŘAZENO PODLE ODLETU"', () => {
    expect(sortCaption('departure')).toBe('SEŘAZENO PODLE ODLETU');
  });
});
