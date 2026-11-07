import { loadMigrations, migrate, migrationStatus, migrationStatusProblems } from '../src/db/migrate.js';
import { OperatorConfigError, resolveOperatorDatabase, resolveRuntimeLogin, seedRefusal, urlForLogin } from '../src/db/operator.js';
import { createPgDb, createPgPool } from '../src/db/pg.js';
import { applyRuntimeGrants, provisionRuntimeRole, RoleProvisioningError, roleExists, RUNTIME_ROLE, runtimeRoleProblems } from '../src/db/roles.js';
import { seed } from '../src/db/seed.js';
import { safeDatabaseError } from '../src/db/startup.js';

// Operator commands, run as the database OWNER from a trusted machine (docs/deployment-render.md):
//   pnpm db:migrate   apply pending migrations, then re-apply mandate_runtime's grants if the role exists
//   pnpm db:status    compare the database with this checkout's migrations; exit 1 if they differ
//   pnpm db:roles     create/update mandate_runtime and the API login (MANDATE_APP_DB_PASSWORD), then check the login
//   pnpm db:seed      demo data (with NODE_ENV=production only when MANDATE_SEED_DEMO=1)
// Connects with MIGRATION_DATABASE_URL (outside production, DATABASE_URL is accepted instead). Never prints URLs.

const COMMANDS = ['migrate', 'status', 'roles', 'seed'] as const;
type Command = (typeof COMMANDS)[number];
const command = process.argv[2] as Command;
if (!COMMANDS.includes(command)) {
  console.error(`Usage: db.ts ${COMMANDS.join('|')}`);
  process.exit(2);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let target;
try {
  target = resolveOperatorDatabase(process.env);
} catch (error) {
  if (error instanceof OperatorConfigError) fail(error.message);
  throw error;
}
console.log(`Connecting with ${target.source}`);

const db = createPgDb(createPgPool(target.url));
let exitCode = 0;
try {
  const migrations = loadMigrations();
  if (command === 'migrate') {
    const applied = await migrate(db, migrations);
    console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Up to date');
    if (await roleExists(db, RUNTIME_ROLE)) {
      const tables = await db.transaction((tx) => applyRuntimeGrants(tx));
      console.log(`Re-applied ${RUNTIME_ROLE} grants on ${tables} tables`);
    } else {
      console.log(`${RUNTIME_ROLE} does not exist yet; run pnpm db:roles to create the API's restricted login`);
    }
  } else {
    const problems = migrationStatusProblems(await migrationStatus(db, migrations));
    if (command === 'status') {
      if (problems.length > 0) {
        console.error(`Schema does not match this checkout: ${problems.join('; ')}`);
        exitCode = 1;
      } else {
        console.log(`Up to date (${migrations.length} migrations)`);
      }
    } else if (problems.length > 0) {
      console.error(`Refusing to ${command}: ${problems.join('; ')}; run pnpm db:migrate first`);
      exitCode = 1;
    } else if (command === 'seed') {
      const refusal = seedRefusal(process.env);
      if (refusal) {
        console.error(refusal);
        exitCode = 1;
      } else {
        await seed(db);
        console.log('Seeded demo data');
      }
    } else {
      const login = resolveRuntimeLogin(process.env);
      const result = await provisionRuntimeRole(db, login);
      console.log(
        `${result.createdGroup ? 'Created' : 'Kept'} ${result.group}; ${result.createdLogin ? 'created' : 'updated'} login ${result.login}; granted on ${result.tables} tables`,
      );
      // Check the login from its own side: it must be able to connect and must be least-privilege.
      const asLogin = createPgDb(createPgPool(urlForLogin(target.url, login)));
      try {
        const loginProblems = await runtimeRoleProblems(asLogin);
        if (loginProblems.length > 0) {
          console.error(`Login ${result.login} is not least-privilege: ${loginProblems.join('; ')}`);
          exitCode = 1;
        } else {
          console.log(`Login ${result.login} connects and passes the least-privilege check.`);
          console.log(`Set the API's DATABASE_URL to the database's INTERNAL URL with user ${result.login} and this password.`);
        }
      } finally {
        await asLogin.close();
      }
    }
  }
} catch (error) {
  console.error(error instanceof OperatorConfigError || error instanceof RoleProvisioningError ? error.message : `Failed: ${safeDatabaseError(error)}`);
  exitCode = 1;
} finally {
  await db.close();
}
process.exit(exitCode);
