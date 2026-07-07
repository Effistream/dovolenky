import { describe, it, expect } from 'vitest';
import {
  formatDayMonth,
  formatTermRange,
  nightsLabel,
  boardLabel,
  departureLabel,
  sourceLabel,
} from './term.js';

describe('formatDayMonth', () => {
  it('formats an ISO date as DD.MM (UTC)', () => {
    expect(formatDayMonth('2026-08-15')).toBe('15.08');
    expect(formatDayMonth('2026-01-05T10:00:00.000Z')).toBe('05.01');
  });
  it('placeholder for missing/invalid', () => {
    expect(formatDayMonth(null)).toBe('—');
    expect(formatDayMonth('not-a-date')).toBe('—');
  });
});

describe('formatTermRange', () => {
  it('builds a start–end range from date + nights', () => {
    expect(formatTermRange('2026-07-08', 7)).toBe('08.07 – 15.07');
  });
  it('date with no nights → just the start', () => {
    expect(formatTermRange('2026-07-08', null)).toBe('08.07');
  });
  it('no date → volný termín', () => {
    expect(formatTermRange(null, 3)).toBe('volný termín');
    expect(formatTermRange('bad', 3)).toBe('volný termín');
  });
});

describe('nightsLabel', () => {
  it('Czech plural forms', () => {
    expect(nightsLabel(1)).toBe('1 noc');
    expect(nightsLabel(2)).toBe('2 noci');
    expect(nightsLabel(4)).toBe('4 noci');
    expect(nightsLabel(7)).toBe('7 nocí');
  });
  it('empty for nullish', () => {
    expect(nightsLabel(null)).toBe('');
  });
});

describe('boardLabel', () => {
  it('maps known board codes', () => {
    expect(boardLabel('AI')).toBe('All inclusive');
    expect(boardLabel('HB')).toBe('Polopenze');
    expect(boardLabel('none')).toBe('Bez stravy');
  });
  it('unknown → em-dash-free placeholder; unmapped passes through', () => {
    expect(boardLabel('unknown')).toBe('—');
    expect(boardLabel(null)).toBe('—');
    expect(boardLabel('XX')).toBe('XX');
  });
});

describe('departureLabel', () => {
  it('uppercases an airport code', () => {
    expect(departureLabel('prg', 'flight')).toBe('PRG');
  });
  it('falls back on transport when no airport', () => {
    expect(departureLabel(null, 'own')).toBe('vlastní');
    expect(departureLabel('', 'bus')).toBe('bus');
    expect(departureLabel(null, 'flight')).toBe('—');
  });
});

describe('sourceLabel', () => {
  it('uppercases the source id', () => {
    expect(sourceLabel('invia')).toBe('INVIA');
    expect(sourceLabel('blue-style')).toBe('BLUE-STYLE');
  });
});
