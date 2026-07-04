import { describe, it, expect } from 'vitest';
import { normalizeBoard, normalizeTransport, normalizeCountry, parseCzk, parseCzDate, offerKeyHash } from '../src/core/normalize.js';

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
});
