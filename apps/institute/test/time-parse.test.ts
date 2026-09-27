import { describe, expect, it } from 'vitest';
import { parseDate, parseTime } from '../src/time-parse';

describe('typed times', () => {
  it('reads the ways people type a time', () => {
    expect(parseTime('10:30', false)).toBe('10:30');
    expect(parseTime('1030', false)).toBe('10:30');
    expect(parseTime('930', false)).toBe('09:30');
    expect(parseTime('9', true)).toBe('21:00');
    expect(parseTime('10.15', true)).toBe('22:15');
    expect(parseTime('2:05 pm', false)).toBe('14:05');
    expect(parseTime('12am', true)).toBe('00:00');
    expect(parseTime('12:30 pm', false)).toBe('12:30');
    expect(parseTime('12:30', true)).toBe('12:30');
    expect(parseTime('14:05', false)).toBe('14:05');
    expect(parseTime('0:10', true)).toBe('00:10');
  });
  it('refuses nonsense', () => {
    for (const bad of ['', '25:00', '10:75', 'ten', '13pm', '1:2', '10:30:00']) expect(parseTime(bad, false)).toBeNull();
  });
});

describe('typed dates', () => {
  it('reads day/month/year in the usual forms', () => {
    expect(parseDate('27/09/2026', 2026)).toBe('2026-09-27');
    expect(parseDate('27-9-26', 2026)).toBe('2026-09-27');
    expect(parseDate('3 10', 2026)).toBe('2026-10-03');
    expect(parseDate('2026-09-27', 2025)).toBe('2026-09-27');
  });
  it('refuses impossible dates', () => {
    for (const bad of ['31/02/2026', '0/1/2026', '12/13/2026', 'soon']) expect(parseDate(bad, 2026)).toBeNull();
  });
});
