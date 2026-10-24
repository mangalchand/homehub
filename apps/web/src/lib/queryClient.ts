import { QueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { createStore, del, get, set } from 'idb-keyval';
import { ApiRequestError } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 1000 * 60 * 60 * 24 * 7,
      retry: (count, err) => !(err instanceof ApiRequestError && err.status >= 400 && err.status < 500) && count < 2,
      networkMode: 'offlineFirst',
      refetchOnWindowFocus: true,
    },
    mutations: { networkMode: 'always' },
  },
});

const idb = createStore('familyhub-cache', 'queries');
/** Persist the query cache in IndexedDB so the dashboard and calendar render offline. */
export const persister = createAsyncStoragePersister({
  storage: { getItem: (k) => get(k, idb), setItem: (k, v) => set(k, v, idb), removeItem: (k) => del(k, idb) },
  key: 'familyhub-query-cache',
  throttleTime: 2000,
});
