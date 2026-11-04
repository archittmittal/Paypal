import { buildApp } from './app.js';
import { ApiConfigError, loadApiConfig } from './config.js';
import type { Db } from './db/db.js';
import { createPgDb, createPgPool } from './db/pg.js';

// Entry point: `pnpm dev` (watch) or `pnpm --filter @mandate/api start`. Everything testable lives in app.ts.

let config;
try {
  config = loadApiConfig(process.env);
} catch (error) {
  if (error instanceof ApiConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const db: Db | undefined = config.databaseUrl ? createPgDb(createPgPool(config.databaseUrl)) : undefined;
const readinessChecks = db ? [{ name: 'postgres', check: async () => void (await db.query('SELECT 1')) }] : [];

const app = await buildApp({ config, readinessChecks });
if (!db) app.log.warn('DATABASE_URL is not set: running without Postgres');

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => db?.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, 'shutdown failed');
          process.exit(1);
        },
      );
  });
}

await app.listen({ port: config.port, host: config.host });
