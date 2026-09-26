import { keyFingerprint, publicKeyFromSecret, sign, toB64url } from '@attendly/protocol';

/** The server's Ed25519 identity. Signs attendance receipts; clients pin its public key. */
export interface ServerSigner {
  kid: string;
  publicKey: Uint8Array;
  publicKeyB64: string;
  sign(message: string): Uint8Array;
}

export function createServerSigner(seed: Uint8Array): ServerSigner {
  const secret = seed.slice(0, 32);
  const publicKey = publicKeyFromSecret(secret);
  return {
    kid: `srv-${keyFingerprint(publicKey)}`,
    publicKey,
    publicKeyB64: toB64url(publicKey),
    sign: (message) => sign(message, secret),
  };
}
