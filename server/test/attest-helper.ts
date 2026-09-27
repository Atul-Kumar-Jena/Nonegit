/**
 * Builds Android key-attestation chains for tests: root → intermediate → leaf, where the leaf carries a
 * KeyDescription (OID 1.3.6.1.4.1.11129.2.1.17) laid out exactly as Android's spec
 * (https://source.android.com/docs/security/features/keystore/attestation). Uses the openssl CLI.
 */
import { execFileSync } from 'node:child_process';
import { createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const len = (n: number) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag: number | Buffer, body: Buffer) => Buffer.concat([Buffer.isBuffer(tag) ? tag : Buffer.from([tag]), len(body.length), body]);
const seq = (...x: Buffer[]) => tlv(0x30, Buffer.concat(x));
const set = (...x: Buffer[]) => tlv(0x31, Buffer.concat(x));
const intBytes = (v: number) => {
  let h = v.toString(16);
  if (h.length % 2) h = `0${h}`;
  const b = Buffer.from(h, 'hex');
  return b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b;
};
const INT = (v: number) => tlv(0x02, intBytes(v));
const ENUM = (v: number) => tlv(0x0a, intBytes(v));
const OCT = (b: Buffer | string) => tlv(0x04, Buffer.isBuffer(b) ? b : Buffer.from(b));
const BOOL = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
/** Explicit context tag [n] (high-tag-number form above 30, as Android uses). */
const ctx = (n: number, inner: Buffer) => {
  if (n < 31) return tlv(0xa0 | n, inner);
  const t: number[] = [];
  let v = n;
  t.unshift(v & 0x7f);
  v >>= 7;
  while (v) {
    t.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return tlv(Buffer.from([0xbf, ...t]), inner);
};

export interface LeafOptions {
  /** 0 software, 1 TEE, 2 StrongBox */
  level?: number;
  locked?: boolean;
  /** 0 verified, 1 self-signed, 2 unverified, 3 failed */
  boot?: number;
  pkg?: string;
  digest?: string;
  rootOfTrust?: boolean;
  appId?: boolean;
}

export function keyDescription(challenge: Buffer, o: LeafOptions = {}): Buffer {
  const { level = 1, locked = true, boot = 0, pkg = 'app.attendly.student', digest = 'ab'.repeat(32), rootOfTrust = true, appId = true } = o;
  const app = seq(set(seq(OCT(pkg), INT(3))), set(OCT(Buffer.from(digest, 'hex'))));
  const sw = seq(ctx(701, INT(1_700_000_000)), ...(appId ? [ctx(709, OCT(app))] : []));
  const hw = [ctx(1, set(INT(2))), ctx(2, INT(3)), ctx(3, INT(256)), ctx(10, INT(1))];
  if (rootOfTrust) hw.push(ctx(704, seq(OCT(Buffer.alloc(32, 7)), BOOL(locked), ENUM(boot), OCT(Buffer.alloc(32, 9)))));
  hw.push(ctx(705, INT(140000)), ctx(706, INT(202608)));
  return seq(INT(300), ENUM(level), INT(300), ENUM(level), OCT(challenge), OCT(Buffer.alloc(0)), sw, seq(...hw));
}

export interface IssuedKey {
  chain: string[];
  /** The "hardware" private key (PKCS#8 PEM) — signs like the phone's security chip would. */
  keyPem: string;
  sign(data: string): string;
}

export interface AttestCA {
  rootPem: string;
  interSerial: string;
  issue(challenge: Buffer, o?: LeafOptions): IssuedKey;
  cleanup(): void;
}

/** A fresh root + intermediate in a temp dir. */
export function createAttestCA(): AttestCA {
  const dir = mkdtempSync(join(tmpdir(), 'attest-'));
  const f = (n: string) => join(dir, n);
  const ssl = (...args: string[]) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const der64 = (pem: string) => execFileSync('openssl', ['x509', '-in', pem, '-outform', 'DER']).toString('base64');
  ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f('root.key'));
  ssl('req', '-new', '-x509', '-key', f('root.key'), '-subj', '/CN=Test Attestation Root', '-days', '3650', '-out', f('root.pem'), '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign');
  ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f('inter.key'));
  ssl('req', '-new', '-key', f('inter.key'), '-subj', '/CN=Test Attestation Intermediate', '-out', f('inter.csr'));
  writeFileSync(f('inter.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n');
  const serial = randomBytes(8).toString('hex');
  ssl('x509', '-req', '-in', f('inter.csr'), '-CA', f('root.pem'), '-CAkey', f('root.key'), '-set_serial', `0x${serial}`, '-days', '3650', '-extfile', f('inter.ext'), '-out', f('inter.pem'));
  const rootB64 = der64(f('root.pem'));
  const interB64 = der64(f('inter.pem'));
  let n = 0;
  return {
    rootPem: readFileSync(f('root.pem'), 'utf8'),
    interSerial: serial,
    issue(challenge, o) {
      const id = `leaf${++n}`;
      ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f(`${id}.key`));
      ssl('req', '-new', '-key', f(`${id}.key`), '-subj', '/CN=Android Keystore Key', '-out', f(`${id}.csr`));
      const kd = keyDescription(challenge, o).toString('hex').match(/../g)!.join(':');
      writeFileSync(f(`${id}.ext`), `keyUsage=critical,digitalSignature\n1.3.6.1.4.1.11129.2.1.17=DER:${kd}\n`);
      ssl('x509', '-req', '-in', f(`${id}.csr`), '-CA', f('inter.pem'), '-CAkey', f('inter.key'), '-set_serial', '1', '-days', '3650', '-extfile', f(`${id}.ext`), '-out', f(`${id}.pem`));
      const key = createPrivateKey(readFileSync(f(`${id}.key`)));
      return {
        chain: [der64(f(`${id}.pem`)), interB64, rootB64],
        keyPem: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
        sign: (data) => cryptoSign('sha256', Buffer.from(data), key).toString('base64'),
      };
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
