/** The sign-in ID last used on this phone, so the authenticator sign-in needs only the 6-digit code. */
import { vault } from './vault';

const KEY = 'signin.id.v1';

export async function rememberSignInId(id: string): Promise<void> {
  await vault.set(KEY, id).catch(() => undefined);
}

export async function lastSignInId(): Promise<string | null> {
  return vault.get<string>(KEY, (v) => (typeof v === 'string' ? v : null) as string).catch(() => null);
}
