import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Integration tests against a real Postgres (`pnpm test:db`). They never skip: with no database they fail,
// so a green run always means the queries really ran. Each file creates and drops its own database.
const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    include: ['test/**/*.db.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
