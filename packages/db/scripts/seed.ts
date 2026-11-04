import { DatabaseConfigError, loadDatabaseConfig } from '../src/config.js';
import { createPool } from '../src/pool.js';
import { SeedConflictError, seed } from '../src/seed.js';

// `pnpm db:seed`: upserts the demo organization, users, mandate and category limits. Idempotent.

try {
  const config = loadDatabaseConfig(process.env, 'admin');
  console.info(`db:seed -> ${config.target}`);
  const pool = createPool(config, { applicationName: 'mandate-seed' });
  try {
    const result = await seed(pool);
    console.info(
      `Seeded ${result.organizations} organization, ${result.users} users, ${result.mandates} mandate, ${result.categoryLimits} category limits.`,
    );
  } finally {
    await pool.end();
  }
} catch (error) {
  if (error instanceof DatabaseConfigError) {
    console.error(`Missing or invalid: ${error.variables.join(', ')}. See .env.example.`);
  } else if (error instanceof SeedConflictError) {
    console.error(`Could not seed: ${error.message}. Nothing was changed.`);
  } else {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    console.error(`Could not seed${code ? ` (${code})` : ''}: ${error instanceof Error ? error.message : String(error)}`);
    if (code === '42P01') console.error('Tables are missing. Run: pnpm db:migrate');
    if (code === 'MD001') console.error('Reservations against the demo mandate exceed the demo budget; nothing was changed.');
    if (code === 'ECONNREFUSED') console.error('Is Postgres running? Try: docker compose up -d');
  }
  process.exitCode = 1;
}
