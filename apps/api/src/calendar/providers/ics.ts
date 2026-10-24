import { sha256 } from '../../lib/crypto.js';
import { safeFetchText } from '../../lib/ssrf.js';
import { parseIcs } from '../ics.js';
import type { CalendarProvider, SyncContext, SyncResult } from './types.js';

/** Read-only ICS/webcal subscription. Each refresh is a full snapshot; unchanged feeds are skipped via ETag/hash. */
export class IcsSubscriptionProvider implements CalendarProvider {
  type = 'ICS_URL' as const;
  capabilities = { oauth: false, twoWay: false, incremental: false, push: false };
  constructor(private fetchText = safeFetchText) {}

  isConfigured() {
    return true;
  }
  async listCalendars() {
    return [];
  }

  async initialSync(ctx: SyncContext): Promise<SyncResult> {
    return this.fetchAndParse(ctx, null);
  }

  async incrementalSync(ctx: SyncContext): Promise<SyncResult> {
    return this.fetchAndParse(ctx, ctx.syncToken);
  }

  /** syncToken format: "<etag>|<sha256 of body>" */
  private async fetchAndParse(ctx: SyncContext, token: string | null): Promise<SyncResult> {
    const [prevEtag, prevHash] = (token ?? '|').split('|');
    const res = await this.fetchText(ctx.sourceUrl!, { etag: prevEtag || null });
    if (res.notModified) return { events: [], deletedExternalIds: [], fullSync: false, nextSyncToken: token, notModified: true };
    if (res.status < 200 || res.status >= 300) throw new Error(`Calendar feed returned HTTP ${res.status}`);
    const hash = sha256(res.body);
    const nextToken = `${res.etag ?? ''}|${hash}`;
    if (hash === prevHash) return { events: [], deletedExternalIds: [], fullSync: false, nextSyncToken: nextToken, notModified: true };
    return { events: parseIcs(res.body, ctx.fallbackTimezone), deletedExternalIds: [], fullSync: true, nextSyncToken: nextToken };
  }
}
