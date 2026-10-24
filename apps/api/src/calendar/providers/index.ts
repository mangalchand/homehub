import type { CalendarProviderType } from '@prisma/client';
import { DemoCalendarProvider } from './demo.js';
import { GoogleCalendarProvider } from './google.js';
import { IcsSubscriptionProvider } from './ics.js';
import { MicrosoftGraphProvider } from './microsoft.js';
import type { CalendarProvider } from './types.js';

export type ProviderKey = 'google' | 'microsoft' | 'ics' | 'demo';

const registry: Record<ProviderKey, CalendarProvider> = {
  google: new GoogleCalendarProvider(),
  microsoft: new MicrosoftGraphProvider(),
  ics: new IcsSubscriptionProvider(),
  demo: new DemoCalendarProvider(),
};

/** Test hook to inject mocked providers. */
export function setProvider(key: ProviderKey, provider: CalendarProvider) {
  registry[key] = provider;
}

export function providerByKey(key: ProviderKey): CalendarProvider {
  return registry[key];
}

export const DEMO_ACCOUNT_PREFIX = 'demo:';

export function providerFor(source: CalendarProviderType, accountExternalId?: string | null): CalendarProvider | null {
  if (accountExternalId?.startsWith(DEMO_ACCOUNT_PREFIX)) return registry.demo;
  switch (source) {
    case 'GOOGLE':
      return registry.google;
    case 'MICROSOFT':
      return registry.microsoft;
    case 'ICS_URL':
      return registry.ics;
    default:
      return null;
  }
}

export function providerCatalog() {
  return [
    { key: 'google', name: 'Google Calendar', configured: registry.google.isConfigured(), capabilities: registry.google.capabilities },
    { key: 'microsoft', name: 'Outlook / Microsoft 365', configured: registry.microsoft.isConfigured(), capabilities: registry.microsoft.capabilities },
    { key: 'icloud', name: 'Apple iCloud', configured: false, capabilities: { oauth: false, twoWay: false, incremental: false, push: false },
      note: 'Use a published iCloud calendar link (ICS). CalDAV two-way sync is on the roadmap.' },
    { key: 'ics', name: 'ICS / webcal subscription', configured: true, capabilities: registry.ics.capabilities },
    { key: 'ics_file', name: 'Upload .ics file', configured: true, capabilities: { oauth: false, twoWay: false, incremental: false, push: false } },
    { key: 'demo', name: 'Demo account (development only)', configured: registry.demo.isConfigured(), capabilities: registry.demo.capabilities },
  ];
}
