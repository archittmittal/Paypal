import { DatabaseConfigError, loadDatabaseConfig, withCredentials } from '../src/config.js';
import { createClient } from '../src/pool.js';
import { provisionLoginRole, publicConnectDatabases, RoleProvisioningError, runtimeRoleProblems } from '../src/roles.js';

// `pnpm db:roles`: creates or updates the LOGIN role the API connects as (a member of mandate_runtime only).
// Run after `pnpm db:migrate`, as the owner (DATABASE_ADMIN_URL in a deployment). Reads:
//   MANDATE_APP_DB_USER      role name, default mandate_app
//   MANDATE_APP_DB_PASSWORD  16-256 printable ASCII characters; required. Sent as a SCRAM verifier, never in clear.
// Then point DATABASE_URL at that role. The password is never printed.

const role = process.env['MANDATE_APP_DB_USER'] || 'mandate_app';
const password = process.env['MANDATE_APP_DB_PASSWORD'] ?? '';

try {
  if (password === '') throw new Error('MANDATE_APP_DB_PASSWORD is not set. See .env.example.');
  const admin = loadDatabaseConfig(process.env, 'admin');
  console.info(`db:roles -> ${admin.target}`);
  const client = createClient(admin, 'mandate-roles');
  await client.connect();
  try {
    const result = await provisionLoginRole(client, role, password);
    console.info(`${result.created ? 'Created' : 'Updated'} login role ${result.role} (member of mandate_runtime only).`);
    if (result.revokedMemberships.length > 0) console.info(`Revoked unexpected memberships: ${result.revokedMemberships.join(', ')}.`);
    if (result.resetSettings.length > 0) console.info(`Reset saved settings of ${result.role} (${result.resetSettings.join(', ')}).`);
  } finally {
    await client.end();
  }

  // Prove it: log in as the new role and check it cannot bypass append-only or the budget triggers.
  const probe = createClient(withCredentials(admin, role, password), 'mandate-roles-check');
  await probe.connect();
  try {
    const problems = await runtimeRoleProblems(probe);
    if (problems.length > 0) throw new Error(`least-privilege check failed: ${problems.join('; ')}`);
    console.info(`Checked: ${role} logs in and has least privilege. Set DATABASE_URL to connect the API as ${role}.`);
    // Roles are cluster-wide: what other databases grant PUBLIC is outside this database's control (a warning, not a failure).
    const reachable = await publicConnectDatabases(probe);
    if (reachable.length > 0) console.warn(`Warning: ${role} can also connect to ${reachable.join(', ')} (CONNECT is open to PUBLIC there). Run pnpm db:harden as a superuser; use one environment per cluster.`);
  } finally {
    await probe.end();
  }
} catch (error) {
  if (error instanceof DatabaseConfigError) {
    console.error(`Missing or invalid: ${error.variables.join(', ')}. See .env.example.`);
  } else if (error instanceof RoleProvisioningError) {
    console.error(`Refused, nothing was changed: ${error.message}`);
  } else {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    console.error(`Could not provision roles${code ? ` (${code})` : ''}: ${error instanceof Error ? error.message : String(error)}`);
    if (code === '42501') console.error('The admin connection lacks CREATEROLE. Ask an administrator to create the role (docs/er-diagram.md).');
  }
  process.exitCode = 1;
}
