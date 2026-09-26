import { Alert } from 'react-native';

/**
 * In release builds React Native terminates the app on any uncaught JS error
 * (an exception in a button handler, a timer, a promise callback…). Instead we
 * keep the app alive and tell the person the action failed safely. Rendering
 * errors are still handled by the ErrorBoundary in app/_layout.tsx.
 *
 * Native crashes can't be caught from JS; those are prevented at the source
 * (e.g. strict address validation before anything reaches the network stack).
 */
type Handler = (error: unknown, isFatal?: boolean) => void;
const utils = (globalThis as { ErrorUtils?: { getGlobalHandler(): Handler; setGlobalHandler(h: Handler): void } }).ErrorUtils;

if (utils && !__DEV__) {
  const defaultHandler = utils.getGlobalHandler();
  const recent: number[] = [];
  let lastAlert = 0;
  utils.setGlobalHandler((error, isFatal) => {
    try {
      const now = Date.now();
      recent.push(now);
      while (recent.length && now - recent[0]! > 10_000) recent.shift();
      // One stray error: keep the app alive. Errors that keep repeating mean the app is in a
      // broken state — hand over to React Native's default handler for a clean restart.
      if (isFatal && recent.length >= 3) {
        defaultHandler(error, isFatal);
        return;
      }
      console.error('[attendly] recovered from uncaught error', error);
      if (now - lastAlert > 4000) {
        lastAlert = now;
        Alert.alert('Something went wrong', 'That action couldn’t finish. Please try again. If the app keeps misbehaving, close and reopen it.');
      }
    } catch {
      // Never let the handler itself throw.
    }
  });
}
