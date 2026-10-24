import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { Toaster } from 'sonner';
import { registerSW } from 'virtual:pwa-register';
import { persister, queryClient } from './lib/queryClient';
import { App } from './App';
import './index.css';

registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 24 * 7, buster: 'v1' }}>
      <BrowserRouter>
        <App />
        <Toaster position="top-center" richColors closeButton />
      </BrowserRouter>
    </PersistQueryClientProvider>
  </StrictMode>,
);
