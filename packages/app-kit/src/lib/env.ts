import Constants from 'expo-constants';

/** The production server built into the apps (a build can override it with EXPO_PUBLIC_API_URL). */
export const BUILT_IN_SERVER_URL = 'https://attendly-api-bt9r.onrender.com';
/** Build-time configuration (EXPO_PUBLIC_* variables are inlined by the bundler). */
export const DEFAULT_SERVER_URL = process.env.EXPO_PUBLIC_API_URL?.trim() || BUILT_IN_SERVER_URL;
/** Optional build-time pin of the server's receipt key (base64url). Strongest protection against a malicious server. */
export const PINNED_SERVER_KEY = process.env.EXPO_PUBLIC_SERVER_KEY?.trim() || '';
/** http:// is only ever allowed in development builds. */
export const ALLOW_HTTP = __DEV__ || process.env.EXPO_PUBLIC_ALLOW_HTTP === '1';
export const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';
