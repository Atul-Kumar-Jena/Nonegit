/**
 * Strict server-address validation, written without the `URL` class.
 *
 * Why: React Native's `URL` performs no validation at all, and a malformed
 * hostname (e.g. "https://.....example.com" or one containing "_") makes
 * Android's OkHttp throw a runtime exception on its dispatcher thread, which
 * terminates the app. Everything that reaches the network layer must pass
 * this check first, and it behaves identically on phones and in Node tests.
 */

export class ServerAddressError extends Error {}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const PATH = /^(?:\/[A-Za-z0-9._~-]+)*$/;

const IPV6_LITERAL = /^\[[0-9a-f:.]{2,45}\]$/;

/** `allowLocal` (dev / LAN builds only) also permits "localhost", single-label hosts and [IPv6] literals. */
export function isValidHostname(host: string, allowLocal: boolean): boolean {
  if (IPV4.test(host)) return true;
  if (allowLocal && IPV6_LITERAL.test(host) && host.includes(':')) return true;
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return allowLocal && LABEL.test(host);
  if (!labels.every((l) => LABEL.test(l))) return false;
  return TLD.test(labels[labels.length - 1]!);
}

/**
 * Parses what a person typed into a canonical base URL like
 * "https://attendly.example.edu" or "https://host:8443/api".
 * A missing scheme defaults to https://. Throws ServerAddressError with a
 * human-readable message for anything else.
 */
export function parseServerAddress(raw: unknown, allowHttp: boolean): string {
  if (typeof raw !== 'string') throw new ServerAddressError('Enter your Attendly server address.');
  let s = raw.trim();
  if (!s) throw new ServerAddressError('Enter your Attendly server address.');
  if (s.length > 300) throw new ServerAddressError('That address is too long.');
  if (/\s/.test(s)) throw new ServerAddressError('The address must not contain spaces.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;

  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(.*)$/i.exec(s);
  if (!m) throw new ServerAddressError('That doesn’t look like a web address. Example: https://attendly.your-college.edu');
  const scheme = m[1]!.toLowerCase();
  const authority = m[2]!;
  const path = m[3]!.replace(/\/+$/, '');
  const rest = m[4]!;

  if (scheme !== 'https' && !(scheme === 'http' && allowHttp))
    throw new ServerAddressError('The address must start with https:// — attendance data is never sent unencrypted.');
  if (rest) throw new ServerAddressError('Remove everything after “?” or “#” from the address.');
  if (authority.includes('@')) throw new ServerAddressError('The address must not contain a username or password.');

  const hp = /^(\[[^\]]*\]|[^:]*)(?::(\d{1,5}))?$/.exec(authority);
  if (!hp) throw new ServerAddressError('The port in that address is not valid.');
  const host = hp[1]!.toLowerCase().replace(/\.$/, '');
  const port = hp[2];
  if (!isValidHostname(host, allowHttp))
    throw new ServerAddressError(
      host.includes('..') || host.startsWith('.')
        ? 'That address has an empty part between dots. Paste the full address exactly as shown, e.g. https://abc-def.trycloudflare.com'
        : 'That isn’t a valid server name. Example: https://attendly.your-college.edu',
    );
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ServerAddressError('The port must be between 1 and 65535.');
  }
  if (!PATH.test(path)) throw new ServerAddressError('The path in that address contains characters that aren’t allowed.');
  const defaultPort = (scheme === 'https' && port === '443') || (scheme === 'http' && port === '80');
  return `${scheme}://${host}${port && !defaultPort ? `:${Number(port)}` : ''}${path}`;
}
