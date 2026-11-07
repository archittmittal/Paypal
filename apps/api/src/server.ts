import { buildApp } from './app.js';
import { compose } from './compose.js';
import { ApiConfigError, loadApiConfig } from './config.js';
import type { Db } from './db/db.js';
import { createPgDb, createPgPool } from './db/pg.js';
import { checkDatabaseAtStartup, DatabaseNotReadyError, safeDatabaseError } from './db/startup.js';
import { startJobs } from './jobs.js';

// Entry point: `pnpm dev` (watch) or `pnpm --filter @mandate/api start`. Everything testable lives in app.ts.
// It never runs migrations: in production they are an operator step (docs/deployment-render.md).

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

let db: Db | undefined;
if (config.databaseUrl) {
  const pool = createPgPool(config.databaseUrl);
  // An idle client losing its connection (database restart) emits 'error'; unhandled, it would crash the process.
  pool.on('error', (error) => console.error(`[db] idle client error: ${safeDatabaseError(error)}`));
  db = createPgDb(pool);
  try {
    // Fail closed before listening: Render keeps the previous deploy serving when the new process exits.
    await checkDatabaseAtStartup(db, {
      production: config.production === true,
      allowPrivilegedRuntime: config.allowPrivilegedRuntime === true,
      warn: (message) => console.warn(`[db] ${message}`),
    });
  } catch (error) {
    console.error(error instanceof DatabaseNotReadyError ? error.message : `Refusing to start: ${safeDatabaseError(error)}`);
    await db.close().catch(() => undefined);
    process.exit(1);
  }
}
const runtimeDb = db;
const readinessChecks = runtimeDb ? [{ name: 'postgres', check: async () => void (await runtimeDb.query('SELECT 1')) }] : [];

// Wired after the app exists so composition logs through the same redacting pino logger.
let services: ReturnType<typeof compose> = { disabled: [] };
const app = await buildApp({
  config,
  readinessChecks,
  compose: (log) => {
    services = compose({ env: process.env, ...(runtimeDb ? { db: runtimeDb } : {}), log });
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
