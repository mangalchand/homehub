import { logger } from '../logger.js';

export interface SummaryFacts {
  household: string;
  date: string;
  tasks: string[];
  chores: string[];
  overdue: number;
  people: { name: string; today: number; total: number; available: number; pendingChores: number }[];
}

/**
 * Optional AI-written summary. Runs only when OPENAI_API_KEY is configured; any failure or timeout
 * returns null so the deterministic summary is used instead. Only names, task titles and point
 * totals are sent: no emails, locations, notes or photos.
 */
export async function writeNarrative(facts: SummaryFacts, fetchImpl: typeof fetch = fetch): Promise<{ text: string } | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || process.env.NODE_ENV === 'test' && !process.env.AI_SUMMARY_TEST) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetchImpl(`${process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.AI_SUMMARY_MODEL ?? 'gpt-4o-mini',
        max_tokens: 350,
        temperature: 0.4,
        messages: [
          { role: 'system', content: 'You write a warm, short evening summary for a family dashboard. 3-5 sentences, plain text, no markdown, no invented facts. Mention who earned the most points today, what is still pending and one encouraging line. It will be read aloud.' },
          { role: 'user', content: JSON.stringify(facts) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`AI summary HTTP ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content?.trim();
    return text ? { text: text.slice(0, 2000) } : null;
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'AI summary unavailable; using standard summary');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
