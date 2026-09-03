import { describe, it, expect } from 'vitest';
import { selectSources } from '../src/cli/select-sources.js';

const ALL = [{ name: 'fischer' }, { name: 'firo' }, { name: 'skrz' }, { name: 'cedok' }];

describe('selectSources', () => {
  it('returns all adapters when raw is null/undefined/empty/whitespace', () => {
    for (const raw of [null, undefined, '', '   ', ',', ' , ']) {
      const { adapters, unknown, excluded } = selectSources(ALL, raw);
      expect(adapters).toHaveLength(ALL.length);
      expect(unknown).toEqual([]);
      expect(excluded).toEqual([]);
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

  // The exclude list exists so the cloud (GitHub Actions) scan can skip the
  // CESYS sources its datacenter IP never reaches (measured 2026-08-27 → 09-03:
  // dovolenkovani 0/55 ok, firo 0/55, zajezdy 0/56) while the Mac fallback
  // still includes them via SCAN_SOURCES.
  describe('excludeRaw (third argument)', () => {
    it('is a no-op when absent/empty/whitespace: same adapters, excluded: []', () => {
      for (const excludeRaw of [undefined, null, '', '   ', ',', ' , ']) {
        const { adapters, unknown, excluded } = selectSources(ALL, null, excludeRaw);
        expect(adapters).toEqual(ALL);
        expect(unknown).toEqual([]);
        expect(excluded).toEqual([]);
      }
    });

    it('removes the named adapters from the full set, reporting them in registry order', () => {
      const { adapters, unknown, excluded } = selectSources(ALL, null, 'skrz,firo');
      expect(adapters.map((a) => a.name)).toEqual(['fischer', 'cedok']);
      expect(excluded).toEqual(['firo', 'skrz']); // registry order, not input order
      expect(unknown).toEqual([]);
    });

    it('trims whitespace around names and ignores empty segments', () => {
      const { adapters, excluded } = selectSources(ALL, null, ' firo , , skrz ');
      expect(adapters.map((a) => a.name)).toEqual(['fischer', 'cedok']);
      expect(excluded).toEqual(['firo', 'skrz']);
    });

    it('applies the exclusion AFTER the inclusion', () => {
      const { adapters, excluded } = selectSources(ALL, 'fischer,firo,skrz', 'firo');
      expect(adapters.map((a) => a.name)).toEqual(['fischer', 'skrz']);
      expect(excluded).toEqual(['firo']);
    });

    it('excluding every included source yields zero adapters (caller treats as misconfig)', () => {
      const { adapters, unknown, excluded } = selectSources(ALL, 'firo', 'firo');
      expect(adapters).toEqual([]);
      expect(unknown).toEqual([]);
      expect(excluded).toEqual(['firo']);
    });

    it('does not report a known-but-not-included name as excluded (nothing was removed)', () => {
      const { adapters, unknown, excluded } = selectSources(ALL, 'fischer', 'firo');
      expect(adapters.map((a) => a.name)).toEqual(['fischer']);
      expect(unknown).toEqual([]);
      expect(excluded).toEqual([]);
    });

    it('sends unknown names from BOTH lists to unknown, include list first', () => {
      const { adapters, unknown, excluded } = selectSources(ALL, 'fischer,bogus', 'nada,firo');
      expect(adapters.map((a) => a.name)).toEqual(['fischer']);
      expect(unknown).toEqual(['bogus', 'nada']);
      expect(excluded).toEqual([]); // firo is known but was not included
    });

    it('reports unknown exclude names even when the include list is empty', () => {
      const { adapters, unknown, excluded } = selectSources(ALL, null, 'nada,firo');
      expect(adapters.map((a) => a.name)).toEqual(['fischer', 'skrz', 'cedok']);
      expect(unknown).toEqual(['nada']);
      expect(excluded).toEqual(['firo']);
    });

    it('does not mutate the input array', () => {
      const before = ALL.map((a) => a.name);
      selectSources(ALL, 'fischer,firo', 'firo');
      expect(ALL.map((a) => a.name)).toEqual(before);
    });
  });
});
