import { DatabaseConfigError, loadDatabaseConfig } from '../src/config.js';
import { createClient } from '../src/pool.js';
import { DEFAULT_DATABASES, hardenDatabase, publicConnectDatabases, restrictPublicConnect, RoleProvisioningError } from '../src/roles.js';

// `pnpm db:harden`: the hardening steps only a superuser can do. Idempotent.
//   1. Revokes EXECUTE on the large-object creating functions from PUBLIC in the Mandate database, so the runtime
//      role cannot create large objects.
//   2. Revokes CONNECT from PUBLIC on the cluster's default databases (postgres, template1), so the runtime login
//      cannot reach them. Other databases on the cluster are listed, never changed: run one environment per cluster.
// Connects with DATABASE_SUPERUSER_URL (required with NODE_ENV=production), else as the admin connection, which must
// then be a superuser (the local compose user is). Migration 0007 already did this if it ran as a superuser.

try {
  const config = loadDatabaseConfig(process.env, 'superuser');
  console.info(`db:harden -> ${config.target}`);
  const client = createClient(config, 'mandate-harden');
  await client.connect();
  try {
    const lo = await hardenDatabase(client);
    if (lo.length > 0) throw new Error(`still executable by PUBLIC: ${lo.join(', ')}`);
    console.info('Large-object creation is no longer open to PUBLIC in this database.');
    const open = await publicConnectDatabases(client);
    const defaults = open.filter((d) => (DEFAULT_DATABASES as readonly string[]).includes(d));
    await restrictPublicConnect(client, defaults);
    if (defaults.length > 0) console.info(`Revoked CONNECT from PUBLIC on: ${defaults.join(', ')}.`);
    const others = await publicConnectDatabases(client);
    if (others.length > 0) console.warn(`Not changed, still open to PUBLIC: ${others.join(', ')}. The runtime login can connect to them.`);
  } finally {
    await client.end();
  }
} catch (error) {
  if (error instanceof DatabaseConfigError) {
    console.error(`Missing or invalid: ${error.variables.join(', ')}. See .env.example.`);
  } else if (error instanceof RoleProvisioningError) {
    console.error(`Refused: ${error.message}`);
  } else {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    console.error(`Could not harden${code ? ` (${code})` : ''}: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
