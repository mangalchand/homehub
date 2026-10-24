import { execSync } from 'node:child_process';

/** Creates (if needed) and migrates the test database. Unit tests do not touch it. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://familyhub:familyhub@localhost:5432/familyhub_test?schema=public';
  if (process.env.SKIP_DB_SETUP === '1') return;
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}
