import { describe, it, expect } from 'vitest';
import { selectSources } from '../src/cli/select-sources.js';

const ALL = [{ name: 'fischer' }, { name: 'firo' }, { name: 'skrz' }, { name: 'cedok' }];

describe('selectSources', () => {
  it('returns all adapters when raw is null/undefined/empty/whitespace', () => {
    for (const raw of [null, undefined, '', '   ', ',', ' , ']) {
      const { adapters, unknown } = selectSources(ALL, raw);
      expect(adapters).toHaveLength(ALL.length);
      expect(unknown).toEqual([]);
    }
  });

  it('filters to a comma-separated subset, preserving registry order', () => {
    const { adapters, unknown } = selectSources(ALL, 'skrz,fischer');
    expect(adapters.map((a) => a.name)).toEqual(['fischer', 'skrz']); // registry order, not input order
    expect(unknown).toEqual([]);
  });

  it('trims whitespace around names and ignores empty segments', () => {
    const { adapters } = selectSources(ALL, ' fischer , , firo ');
    expect(adapters.map((a) => a.name)).toEqual(['fischer', 'firo']);
  });

  it('selects a single source', () => {
    const { adapters, unknown } = selectSources(ALL, 'firo');
    expect(adapters.map((a) => a.name)).toEqual(['firo']);
    expect(unknown).toEqual([]);
  });

  it('reports unknown names but still returns the known matches', () => {
    const { adapters, unknown } = selectSources(ALL, 'fischer,bogus,skrz');
    expect(adapters.map((a) => a.name)).toEqual(['fischer', 'skrz']);
    expect(unknown).toEqual(['bogus']);
  });

  it('returns empty adapters (caller treats as misconfig) when no name matches', () => {
    const { adapters, unknown } = selectSources(ALL, 'nope,nada');
    expect(adapters).toEqual([]);
    expect(unknown).toEqual(['nope', 'nada']);
  });

  it('does not mutate the input array and returns a fresh array for the all-case', () => {
    const { adapters } = selectSources(ALL, null);
    expect(adapters).not.toBe(ALL);
    expect(adapters).toEqual(ALL);
  });
});
