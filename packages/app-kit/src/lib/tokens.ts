import { AuthTokens } from '@attendly/protocol';
import type { TokenStore } from './api-core';
import { StorageKeys, deleteItem, getJson, setJson } from './storage';

let memo: AuthTokens | null | undefined;

export const tokenStore: TokenStore = {
  async get() {
    if (memo !== undefined) return memo;
    memo = await getJson(StorageKeys.tokens, (v) => AuthTokens.parse(v));
    return memo;
  },
  async set(tokens) {
    memo = tokens;
    await setJson(StorageKeys.tokens, tokens);
  },
  async clear() {
    memo = null;
    await deleteItem(StorageKeys.tokens);
  },
};
