import { defineConfig, devices } from '@playwright/test';

const reuse = !process.env.CI;

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure', timezoneId: 'America/New_York' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'tablet', use: { ...devices['Galaxy Tab S4 landscape'] ?? { viewport: { width: 1280, height: 800 } } } },
  ],
  webServer: [
    { command: 'pnpm --filter @familyhub/api dev', url: 'http://localhost:4000/healthz', reuseExistingServer: reuse, timeout: 60_000 },
    { command: 'pnpm --filter @familyhub/web dev', url: 'http://localhost:5173', reuseExistingServer: reuse, timeout: 60_000 },
  ],
});
