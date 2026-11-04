import { DatabaseConfigError, loadDatabaseConfig } from '../src/config.js';
import { MigrationError, migrate } from '../src/migrations.js';

// `pnpm db:migrate`: applies pending migrations from packages/db/migrations. Prints the target as
// host:port/database only; the connection string carries the password and is never printed.

try {
  const config = loadDatabaseConfig(process.env, 'admin');
  console.info(`db:migrate -> ${config.target}`);
  const result = await migrate(config, { log: (line) => console.info(`  ${line}`) });
  console.info(
    result.applied.length === 0
      ? `Up to date (${result.alreadyApplied} migrations already applied).`
      : `Applied ${result.applied.length} migration(s).`,
  );
} catch (error) {
  if (error instanceof DatabaseConfigError) {
    console.error(`Missing or invalid: ${error.variables.join(', ')}. See .env.example.`);
  } else if (error instanceof MigrationError) {
    console.error(error.message);
  } else {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    console.error(`Could not migrate${code ? ` (${code})` : ''}: ${error instanceof Error ? error.message : String(error)}`);
    if (code === 'ECONNREFUSED') console.error('Is Postgres running? Try: docker compose up -d');
  }
  process.exitCode = 1;
}
