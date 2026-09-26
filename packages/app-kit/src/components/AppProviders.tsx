import { useState, type ReactNode } from 'react';
import { QueryClient, focusManager } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { AppState, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ApiRequestError } from '../lib/api-core';
import { APP_VERSION } from '../lib/env';
import { vaultStorage } from '../lib/vault';
import { SessionProvider, type AppAudience } from '../state/session';
import { colors } from '../theme';

// Refetch when the app returns to the foreground.
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (s) => focusManager.setFocused(s === 'active'));
}

const DAY = 24 * 60 * 60_000;

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // Kept long enough to be persisted: screens open instantly — also offline.
        gcTime: 7 * DAY,
        retry: (count, err) => err instanceof ApiRequestError && err.transient && count < 2,
        retryDelay: (n) => Math.min(1000 * 2 ** n, 5000),
        networkMode: 'offlineFirst',
      },
      mutations: { retry: false, networkMode: 'always' },
    },
  });
}

const persister = createAsyncStoragePersister({ storage: vaultStorage, key: 'query-cache.v1', throttleTime: 2000 });

/** Query cache persisted encrypted on the device + session. Shared by both apps. */
export function AppProviders({ audience, children }: { audience: AppAudience; children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  return (
    <SafeAreaProvider style={{ backgroundColor: colors.bg }}>
      <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: 7 * DAY, buster: APP_VERSION }}>
        <SessionProvider audience={audience}>{children}</SessionProvider>
      </PersistQueryClientProvider>
    </SafeAreaProvider>
  );
}
