import Constants from 'expo-constants';

/** Build-time configuration (EXPO_PUBLIC_* variables are inlined by the bundler). */
export const DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_API_URL?.trim() || '';
/** Optional build-time pin of the server's receipt key (base64url). Strongest protection against a malicious server. */
export const PINNED_SERVER_KEY = process.env.EXPO_PUBLIC_SERVER_KEY?.trim() || '';
/** http:// is only ever allowed in development builds. */
export const ALLOW_HTTP = __DEV__ || process.env.EXPO_PUBLIC_ALLOW_HTTP === '1';
export const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';
