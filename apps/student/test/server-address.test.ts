import { describe, expect, it } from 'vitest';
import { ServerAddressError, isValidHostname, parseServerAddress } from '../src/lib/server-address';

const ok = (raw: string, allowHttp = false) => parseServerAddress(raw, allowHttp);
const bad = (raw: unknown, allowHttp = false) => {
  expect(() => parseServerAddress(raw, allowHttp)).toThrow(ServerAddressError);
};

describe('parseServerAddress', () => {
  it('accepts and canonicalises real addresses', () => {
    expect(ok('https://attendly-api-x1y2.onrender.com')).toBe('https://attendly-api-x1y2.onrender.com');
    expect(ok('  HTTPS://Abc-Def.TryCloudflare.com/  ')).toBe('https://abc-def.trycloudflare.com');
    expect(ok('attendly.college.edu')).toBe('https://attendly.college.edu'); // scheme optional
    expect(ok('https://a.edu:8443/api//')).toBe('https://a.edu:8443/api');
    expect(ok('https://a.edu:443')).toBe('https://a.edu');
    expect(ok('https://xn--80ak6aa92e.xn--p1ai')).toBe('https://xn--80ak6aa92e.xn--p1ai');
    expect(ok('https://attendly.example.com.')).toBe('https://attendly.example.com');
    expect(ok('http://192.168.1.20:4000', true)).toBe('http://192.168.1.20:4000');
    expect(ok('http://localhost:4000', true)).toBe('http://localhost:4000');
    expect(ok('http://devbox:4000', true)).toBe('http://devbox:4000'); // LAN names in dev builds
    expect(ok('http://[::1]:4000', true)).toBe('http://[::1]:4000');
  });

  it('rejects the inputs that crashed the Android app (instead of passing them to OkHttp)', () => {
    for (const raw of [
      'https://.....trycloudflare.com',
      'https://.....',
      'https://a..b.com',
      'https://.trycloudflare.com',
      'https://under_score.example.com',
      'https://-lead.example.com',
      'https://trail-.example.com',
      'https://exa mple.com',
      'https://ex%61mple.com',
      'https://例え.jp',
      'https://',
      'https://:443',
      'https://com',
      'https://example.c',
      'https://example.123',
      'https://' + 'a'.repeat(64) + '.com',
      'https://256.1.1.1',
      'https://a.edu:0',
      'https://a.edu:65536',
      'https://a.edu:12a',
      'https://u:p@a.edu',
      'https://a.edu/?x=1',
      'https://a.edu/#frag',
      'https://a.edu/pa th',
      'https://a.edu/<script>',
      'ftp://a.edu',
      'javascript:alert(1)',
      '',
      '   ',
      null,
      42,
    ])
      bad(raw);
  });

  it('enforces https in release builds', () => {
    bad('http://attendly.example.com');
    bad('http://localhost:4000');
    bad('http://192.168.1.20:4000');
    bad('https://devbox'); // single-label hosts only in dev builds
    bad('https://[::1]');
  });

  it('gives a specific hint for empty dot segments', () => {
    expect(() => ok('https://.....trycloudflare.com')).toThrow(/empty part between dots/);
  });

  it('never produces an address that fails its own validation (idempotent)', () => {
    for (const raw of ['a.edu', 'https://A.EDU:8443/x/', 'https://a.edu:443/', 'http://10.0.0.2:80', 'attendly.example.com./api']) {
      const once = parseServerAddress(raw, true);
      expect(parseServerAddress(once, true)).toBe(once);
    }
  });

  it('fuzz: random strings either throw ServerAddressError or yield a safe canonical URL', () => {
    const alphabet = 'abc.-_:/@?#% 0123456789XYZé';
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 20_000; i++) {
      let s = rnd() < 0.5 ? 'https://' : '';
      const n = Math.floor(rnd() * 30);
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      try {
        const out = parseServerAddress(s, false);
        expect(out).toMatch(/^https:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~-]+)*$/);
        const host = out.replace(/^https:\/\//, '').split(/[:/]/)[0]!;
        expect(isValidHostname(host, false)).toBe(true);
      } catch (e) {
        expect(e).toBeInstanceOf(ServerAddressError);
      }
    }
  });
});
