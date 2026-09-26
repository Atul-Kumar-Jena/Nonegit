import { z } from 'zod';
import { fromB64url, isB64urlOfLength, type MetaResponse } from '@attendly/protocol';
import { StorageKeys, deleteItem, getJson, setJson } from './storage';
import { PINNED_SERVER_KEY } from './env';

/**
 * The server this app talks to, plus its pinned Ed25519 receipt key
 * (trust-on-first-use unless a key is pinned at build time). If the server
 * ever presents a different key, the app refuses to continue.
 */
export const ServerConfig = z.object({
  url: z.string().min(1),
  kid: z.string().min(1),
  publicKey: z.string().refine((s) => isB64urlOfLength(s, 32)),
});
export type ServerConfig = z.infer<typeof ServerConfig>;

export async function loadServerConfig(): Promise<ServerConfig | null> {
  return getJson(StorageKeys.server, (v) => ServerConfig.parse(v));
}

export async function saveServerConfig(c: ServerConfig): Promise<void> {
  await setJson(StorageKeys.server, c);
}

export async function clearServerConfig(): Promise<void> {
  await deleteItem(StorageKeys.server);
}

export class ServerIdentityError extends Error {}

/** Checks a freshly fetched /v1/meta against the pin and returns the config to store. */
export function checkServerIdentity(url: string, meta: MetaResponse, existing: ServerConfig | null): ServerConfig {
  if (PINNED_SERVER_KEY && meta.serverKey.publicKey !== PINNED_SERVER_KEY)
    throw new ServerIdentityError('This server’s identity does not match the one built into the app. Do not continue.');
  if (existing && existing.url === url && existing.publicKey !== meta.serverKey.publicKey)
    throw new ServerIdentityError('The server’s signing identity has changed since you last used it. This can mean someone is intercepting your connection. Contact your institution before continuing.');
  return { url, kid: meta.serverKey.kid, publicKey: meta.serverKey.publicKey };
}

export function pinnedKey(c: ServerConfig): { kid: string; publicKey: Uint8Array } {
  return { kid: c.kid, publicKey: fromB64url(c.publicKey) };
}

export function displayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
