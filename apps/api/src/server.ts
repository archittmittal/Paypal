import { buildApp } from './app.js';
import { compose } from './compose.js';
import { ApiConfigError, loadApiConfig } from './config.js';
import type { Db } from './db/db.js';
import { createPgDb, createPgPool } from './db/pg.js';
import { startJobs } from './jobs.js';

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

// Wired after the app exists so composition logs through the same redacting pino logger.
let services: ReturnType<typeof compose> = { disabled: [] };
const app = await buildApp({
  config,
  readinessChecks,
  compose: (log) => {
    services = compose({ env: process.env, ...(db ? { db } : {}), log });
    return services;
  },
});
for (const { feature, missing } of services.disabled) app.log.warn({ feature, missing }, 'feature disabled: configuration missing');
const jobs = services.purchases ? startJobs(services.purchases, { log: app.log }) : undefined;

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    Promise.resolve(jobs?.stop())
      .then(() => app.close())
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
