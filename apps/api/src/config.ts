import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .min(1, 'ENCRYPTION_KEY is required (openssl rand -base64 32)')
    .refine((k) => Buffer.from(k, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes, base64 encoded'),
  COOKIE_SECURE: bool(false),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  DEVICE_SESSION_TTL_DAYS: z.coerce.number().default(365),
  WORKER_MODE: z.enum(['inline', 'separate', 'off']).default('inline'),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  MICROSOFT_CLIENT_ID: z.string().optional().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().optional().default(''),
  MICROSOFT_TENANT: z.string().default('common'),
  ENABLE_DEMO_PROVIDER: bool(false),
  WEATHER_ENABLED: bool(true),
  EMAIL_FROM: z.string().default('FamilyHub <no-reply@familyhub.local>'),
  /** Allow ICS subscriptions to private network addresses. Only for local testing. */
  ALLOW_PRIVATE_ICS_HOSTS: bool(false),
  /** Where uploaded family photos are stored: local disk (dev/self-host) or S3 (AWS). */
  /** Number of reverse proxies in front of the API (nginx = 1; Caddy + nginx = 2). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
  /** Web Push (VAPID). If unset, a key pair is generated once and stored next to the uploads. */
  VAPID_PUBLIC_KEY: z.string().optional().default(''),
  VAPID_PRIVATE_KEY: z.string().optional().default(''),
  VAPID_SUBJECT: z.string().default('mailto:admin@familyhub.app'),
  /** WhatsApp Cloud API (Meta). Leave empty to disable WhatsApp notifications. */
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().optional().default(''),
  /** Approved template with two body parameters ({{1}} title, {{2}} details). Empty = plain text (24h session only). */
  WHATSAPP_TEMPLATE: z.string().optional().default(''),
  WHATSAPP_TEMPLATE_LANG: z.string().default('en_US'),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  S3_BUCKET: z.string().optional().default(''),
  AWS_REGION: z.string().optional().default('us-east-1'),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.ENABLE_DEMO_PROVIDER) {
    throw new Error('ENABLE_DEMO_PROVIDER must not be enabled in production');
  }
  return parsed.data;
}

export const config = load();

export const providerConfigured = {
  google: () => Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
  microsoft: () => Boolean(config.MICROSOFT_CLIENT_ID && config.MICROSOFT_CLIENT_SECRET),
};
