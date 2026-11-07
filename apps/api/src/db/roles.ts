import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { Db, Queryable } from './db.js';

/**
 * Least-privilege database access for the API (issue #14).
 *
 * The database owner (the role Render creates with the database) runs migrations and owns every table. The API
 * logs in as a separate role that is a member of `mandate_runtime` only, so it cannot run DDL, disable the
 * append-only and payment-authorization triggers (only an owner can), truncate tables, or touch schema_migrations.
 *
 *   mandate_runtime   NOLOGIN group role; holds the table privileges in RUNTIME_TABLE_PRIVILEGES
 *   mandate_app       LOGIN role (name configurable), member of mandate_runtime and nothing else
 *
 * Roles are cluster-wide in PostgreSQL: use one cluster (one Render database instance) per environment.
 */

export const RUNTIME_ROLE = 'mandate_runtime';
export const DEFAULT_APP_LOGIN = 'mandate_app';

const ROLE_NAME = /^[a-z_][a-z0-9_]{2,62}$/;
// Printable ASCII only: SASLprep (RFC 4013) is then the identity, so the verifier below matches what libpq sends.
const PASSWORD = /^[\x21-\x7e]{16,256}$/;
const SCRAM_ITERATIONS = 4096;

const READ_WRITE = ['SELECT', 'INSERT', 'UPDATE'] as const;

/**
 * Exactly what the API may do on each table. Every table the migrations create must be listed: a test fails when
 * one is missing (apps/api/test/deployment.test.ts), so a new table's access is always a deliberate decision.
 * A table missing here anyway gets UNLISTED_TABLE_PRIVILEGES (read-only), never write access by default.
 */
export const RUNTIME_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  // Read for the start-up schema check; only migrations write it.
  schema_migrations: ['SELECT'],
  // Append-only (triggers also refuse UPDATE/DELETE/TRUNCATE for every role).
  audit_log: ['SELECT', 'INSERT'],
  order_event: ['SELECT', 'INSERT'],
  // Mandate setup replaces a mandate's category limits (modules/mandates/service.ts).
  category_limit: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  organization: READ_WRITE,
  app_user: READ_WRITE,
  mandate: READ_WRITE,
  purchase_request: READ_WRITE,
  product_snapshot: READ_WRITE,
  cart: READ_WRITE,
  cart_item: READ_WRITE,
  policy_decision: READ_WRITE,
  budget_reservation: READ_WRITE,
  approval: READ_WRITE,
  payment_order: READ_WRITE,
  webhook_event: READ_WRITE,
  shipment: READ_WRITE,
  refund: READ_WRITE,
};
export const UNLISTED_TABLE_PRIVILEGES = ['SELECT'] as const;

export function runtimePrivilegesFor(table: string): readonly string[] {
  return RUNTIME_TABLE_PRIVILEGES[table] ?? UNLISTED_TABLE_PRIVILEGES;
}

/**
 * A SCRAM-SHA-256 verifier in the format Postgres stores (RFC 5802 / 7677). Sending this instead of the password
 * keeps the plaintext out of the SQL text, and therefore out of server statement logs.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  if (!PASSWORD.test(password)) throw new RangeError('password must be 16 to 256 printable ASCII characters, no spaces');
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** Identifiers are validated against ROLE_NAME (or come from the catalogs) first; quoting is belt and braces. */
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Provisioning refused. Nothing was changed: provisioning runs in one transaction. Names roles, never secrets. */
export class RoleProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleProvisioningError';
  }
}

/** Roles `$1` inherits or can SET ROLE to, transitively, and whether each is privileged. */
const MEMBERSHIP_CLOSURE = `
  WITH RECURSIVE closure(oid) AS (
    SELECT am.roleid FROM pg_catalog.pg_auth_members AS am WHERE am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
    UNION
    SELECT am.roleid FROM pg_catalog.pg_auth_members AS am JOIN closure AS c ON am.member = c.oid
  )
  SELECT r.rolname AS name,
         (r.rolname LIKE 'pg\\_%' OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls) AS privileged,
         EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS am
                  WHERE am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1) AND am.roleid = r.oid) AS direct
    FROM closure AS c JOIN pg_catalog.pg_roles AS r ON r.oid = c.oid
   ORDER BY r.rolname`;

interface Membership {
  name: string;
  privileged: boolean;
  direct: boolean;
}

async function memberships(q: Queryable, role: string): Promise<Membership[]> {
  return (await q.query<Membership>(MEMBERSHIP_CLOSURE, [role])).rows;
}

/** Objects in this database owned by `$1` or by a role it belongs to (it could act as their owner). */
const OWNED_OBJECTS = `
  SELECT (SELECT count(*) FROM pg_catalog.pg_class c WHERE pg_catalog.pg_has_role($1, c.relowner, 'MEMBER'))
       + (SELECT count(*) FROM pg_catalog.pg_proc p WHERE pg_catalog.pg_has_role($1, p.proowner, 'MEMBER'))
       + (SELECT count(*) FROM pg_catalog.pg_namespace n WHERE pg_catalog.pg_has_role($1, n.nspowner, 'MEMBER'))
       + (SELECT count(*) FROM pg_catalog.pg_type t WHERE pg_catalog.pg_has_role($1, t.typowner, 'MEMBER'))
       + (SELECT count(*) FROM pg_catalog.pg_database d WHERE d.datname = current_database() AND pg_catalog.pg_has_role($1, d.datdba, 'MEMBER'))
       AS owned`;

/** Privileges granted to `$1` itself rather than through mandate_runtime (table, column, schema, function, type, database). */
const DIRECT_GRANTS = `
  WITH acl(kind, name, grantee, privilege) AS (
    SELECT 'table', c.oid::regclass::text, a.grantee, a.privilege_type FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
    UNION ALL SELECT 'column', c.oid::regclass::text || '.' || att.attname, a.grantee, a.privilege_type
      FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid = att.attrelid, aclexplode(att.attacl) a
    UNION ALL SELECT 'schema', n.nspname, a.grantee, a.privilege_type FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) a
    UNION ALL SELECT 'function', p.oid::regprocedure::text, a.grantee, a.privilege_type FROM pg_catalog.pg_proc p, aclexplode(p.proacl) a
    UNION ALL SELECT 'type', t.oid::regtype::text, a.grantee, a.privilege_type FROM pg_catalog.pg_type t, aclexplode(t.typacl) a
    UNION ALL SELECT 'database', d.datname, a.grantee, a.privilege_type FROM pg_catalog.pg_database d, aclexplode(d.datacl) a
  )
  SELECT kind || ' ' || name || ': ' || privilege AS grant
    FROM acl
   WHERE grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
   ORDER BY 1`;

async function directGrants(q: Queryable, role: string): Promise<string[]> {
  return (await q.query<{ grant: string }>(DIRECT_GRANTS, [role])).rows.map((r) => r.grant);
}

/** Per-role saved settings (ALTER ROLE ... SET), which apply to every session: null scope means all databases. */
async function savedSettings(q: Queryable, role: string): Promise<(string | null)[]> {
  const { rows } = await q.query<{ database: string | null }>(
    `SELECT d.datname AS database FROM pg_catalog.pg_db_role_setting s LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
      WHERE s.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)`,
    [role],
  );
  return rows.map((r) => r.database);
}

/** Roles that `$1` holds ADMIN OPTION on (it could grant them to others or revoke them). */
async function adminOptions(q: Queryable, role: string): Promise<string[]> {
  const { rows } = await q.query<{ name: string }>(
    `SELECT r.rolname AS name FROM pg_catalog.pg_auth_members am JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
      WHERE am.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1) AND am.admin_option ORDER BY 1`,
    [role],
  );
  return rows.map((r) => r.name);
}

const PRIVILEGED_ATTRIBUTES = 'rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls';

/**
 * Re-applies mandate_runtime's privileges from RUNTIME_TABLE_PRIVILEGES: revokes every table privilege in schema
 * public from mandate_runtime and from PUBLIC (table-level revokes also remove column-level grants), then grants
 * exactly the listed privileges, plus USAGE on the schema and USAGE/SELECT on its sequences. Run by `pnpm db:roles`,
 * and by `pnpm db:migrate` when the role exists, so a new table is covered as soon as its migration runs.
 * Returns the number of tables.
 */
export async function applyRuntimeGrants(q: Queryable, group = RUNTIME_ROLE): Promise<number> {
  const { rows } = await q.query<{ table: string }>(
    "SELECT tablename AS table FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  await q.query(`GRANT USAGE ON SCHEMA public TO ${ident(group)}`);
  await q.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ident(group)}, PUBLIC`);
  for (const { table } of rows) {
    await q.query(`GRANT ${runtimePrivilegesFor(table).join(', ')} ON TABLE public.${ident(table)} TO ${ident(group)}`);
  }
  await q.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(group)}`);
  return rows.length;
}

/** Whether `role` exists. */
export async function roleExists(q: Queryable, role: string): Promise<boolean> {
  return (await q.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [role])).rows.length > 0;
}

/**
 * Why the connected (owner) role cannot provision the roles, or undefined if it can. A superuser can. Otherwise it
 * needs CREATEROLE and, on PostgreSQL 16+, ADMIN OPTION on mandate_runtime and on the login if either already exists
 * and was created by someone else (the role that creates a role gets ADMIN OPTION on it automatically).
 */
export async function provisioningPrivilegeProblem(q: Queryable, group = RUNTIME_ROLE, login = DEFAULT_APP_LOGIN): Promise<string | undefined> {
  const { rows } = await q.query<{ role: string; superuser: boolean; createrole: boolean; version: number }>(
    `SELECT current_user AS role, r.rolsuper AS superuser, r.rolcreaterole AS createrole,
            current_setting('server_version_num')::int AS version
       FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
  );
  const me = rows[0];
  if (me === undefined) return 'could not read the connected role';
  if (me.superuser) return undefined;
  if (!me.createrole) {
    return `role ${me.role} lacks CREATEROLE, which creating the API's login role needs (check with: SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user)`;
  }
  if (me.version < 160000) return undefined;
  for (const role of [group, login]) {
    const admin = await q.query<{ ok: boolean }>(
      `SELECT pg_catalog.pg_has_role(current_user, $1, 'MEMBER WITH ADMIN OPTION') AS ok
        WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1)`,
      [role],
    );
    if (admin.rows[0]?.ok === false) {
      return `role ${me.role} lacks ADMIN OPTION on existing role ${role} (PostgreSQL 16+); its creator or a superuser can run: GRANT ${role} TO ${me.role} WITH ADMIN OPTION`;
    }
  }
  return undefined;
}

export interface ProvisionOptions {
  login?: string;
  password: string;
  group?: string;
}

export interface ProvisionResult {
  group: string;
  login: string;
  createdGroup: boolean;
  createdLogin: boolean;
  tables: number;
}

/**
 * Creates or updates mandate_runtime and the API's login role, sets the login's password (as a SCRAM verifier,
 * with no expiry), clears its saved settings and any ADMIN OPTION it holds, and applies the table privileges.
 * Idempotent; one transaction, so a refusal changes nothing. Refuses to reuse an existing role that is privileged,
 * owns objects, holds grants of its own or belongs to another role. Run as the database owner, after migrations.
 */
export async function provisionRuntimeRole(db: Db, options: ProvisionOptions): Promise<ProvisionResult> {
  const login = options.login ?? DEFAULT_APP_LOGIN;
  const group = options.group ?? RUNTIME_ROLE;
  for (const name of [login, group]) {
    if (!ROLE_NAME.test(name)) throw new RangeError(`role name ${name} must match ${String(ROLE_NAME)}`);
  }
  if (login === group) throw new RangeError('the login role and the group role must differ');
  const verifier = literal(scramVerifier(options.password));

  return db.transaction(async (tx) => {
    const problem = await provisioningPrivilegeProblem(tx, group, login);
    if (problem !== undefined) throw new RoleProvisioningError(problem);

    const groupRow = (
      await tx.query<{ clean: boolean }>(
        `SELECT NOT (${PRIVILEGED_ATTRIBUTES} OR rolcanlogin) AS clean FROM pg_catalog.pg_roles WHERE rolname = $1`,
        [group],
      )
    ).rows[0];
    if (groupRow === undefined) {
      await tx.query(`CREATE ROLE ${ident(group)} NOLOGIN`);
    } else {
      if (!groupRow.clean) throw new RoleProvisioningError(`existing role ${group} has LOGIN or a privileged attribute; refusing to use it`);
      const held = await memberships(tx, group);
      if (held.length > 0) throw new RoleProvisioningError(`existing role ${group} is a member of ${held.map((m) => m.name).join(', ')}; refusing to use it`);
    }

    const loginRow = (
      await tx.query<{ privileged: boolean }>(`SELECT (${PRIVILEGED_ATTRIBUTES}) AS privileged FROM pg_catalog.pg_roles WHERE rolname = $1`, [login])
    ).rows[0];
    if (loginRow === undefined) {
      // Attributes default to NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS. They are not named,
      // because naming some of them (even as NO...) needs that privilege, which a CREATEROLE-only owner lacks.
      await tx.query(`CREATE ROLE ${ident(login)} LOGIN INHERIT PASSWORD ${verifier} VALID UNTIL 'infinity'`);
    } else {
      if (loginRow.privileged) throw new RoleProvisioningError(`existing role ${login} has a privileged attribute; refusing to reuse it`);
      const held = await memberships(tx, login);
      const other = held.filter((m) => m.name !== group);
      if (other.length > 0) {
        throw new RoleProvisioningError(`existing role ${login} is a member of ${other.map((m) => m.name).join(', ')}; refusing to reuse it`);
      }
      const owned = (await tx.query<{ owned: number | string }>(OWNED_OBJECTS, [login])).rows[0]?.owned ?? 0;
      if (Number(owned) > 0) throw new RoleProvisioningError(`existing role ${login} owns objects in this database; refusing to reuse it`);
      const grants = await directGrants(tx, login);
      if (grants.length > 0) throw new RoleProvisioningError(`existing role ${login} holds privileges of its own; refusing to reuse it`);
      await tx.query(`ALTER ROLE ${ident(login)} LOGIN INHERIT PASSWORD ${verifier} VALID UNTIL 'infinity'`);
      // Saved settings (ALTER ROLE ... SET search_path = ...) apply to every later session: start from none.
      for (const scope of await savedSettings(tx, login)) {
        await tx.query(scope === null ? `ALTER ROLE ${ident(login)} RESET ALL` : `ALTER ROLE ${ident(login)} IN DATABASE ${ident(scope)} RESET ALL`);
      }
    }
    await tx.query(`GRANT ${ident(group)} TO ${ident(login)}`);
    if ((await adminOptions(tx, login)).includes(group)) await tx.query(`REVOKE ADMIN OPTION FOR ${ident(group)} FROM ${ident(login)}`);
    const tables = await applyRuntimeGrants(tx, group);

    const after = await memberships(tx, login);
    if (after.length !== 1 || after[0]?.name !== group) {
      throw new RoleProvisioningError(`role ${login} must be a member of ${group} only, but is a member of: ${after.map((m) => m.name).join(', ')}`);
    }
    if ((await adminOptions(tx, login)).length > 0 || (await savedSettings(tx, login)).length > 0) {
      throw new RoleProvisioningError(`could not clear ADMIN OPTION or saved settings of role ${login}`);
    }
    return { group, login, createdGroup: groupRow === undefined, createdLogin: loginRow === undefined, tables };
  });
}

/** Per-table privileges checked by runtimeRoleProblems, beyond SELECT. Column grants count (has_any_column_privilege). */
const TABLE_PRIVILEGE_CHECK = `
  SELECT tablename AS table,
         pg_catalog.has_table_privilege(format('public.%I', tablename), 'SELECT')              AS "SELECT",
         pg_catalog.has_any_column_privilege(format('public.%I', tablename), 'INSERT')         AS "INSERT",
         pg_catalog.has_any_column_privilege(format('public.%I', tablename), 'UPDATE')         AS "UPDATE",
         pg_catalog.has_table_privilege(format('public.%I', tablename), 'DELETE')              AS "DELETE",
         pg_catalog.has_table_privilege(format('public.%I', tablename), 'TRUNCATE')            AS "TRUNCATE",
         pg_catalog.has_any_column_privilege(format('public.%I', tablename), 'REFERENCES')     AS "REFERENCES",
         pg_catalog.has_table_privilege(format('public.%I', tablename), 'TRIGGER')             AS "TRIGGER",
         CASE WHEN current_setting('server_version_num')::int >= 170000
              THEN pg_catalog.has_table_privilege(format('public.%I', tablename), 'MAINTAIN') ELSE false END AS "MAINTAIN"
    FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename`;

const CHECKED_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] as const;

/**
 * Problems that would let the CONNECTED role act beyond least privilege, as far as this database can tell. Empty
 * means: no privileged attribute on the login or on any role it belongs to; a member of `group` only, without ADMIN
 * OPTION; `group` a member of nothing; no grants of its own; no saved settings; owns nothing; can read every table and
 * holds no table or column privilege beyond RUNTIME_TABLE_PRIVILEGES (including TRIGGER, REFERENCES, MAINTAIN);
 * cannot create schemas in this database or objects in any schema. Messages name roles and tables, never credentials.
 * Not covered (documented): TEMP and function EXECUTE, which PostgreSQL grants to PUBLIC by default.
 */
export async function runtimeRoleProblems(q: Queryable, group = RUNTIME_ROLE): Promise<string[]> {
  const { rows } = await q.query<{ role: string; superuser: boolean; createrole: boolean; createdb: boolean; replication: boolean; bypassrls: boolean }>(
    `SELECT rolname AS role, rolsuper AS superuser, rolcreaterole AS createrole, rolcreatedb AS createdb,
            rolreplication AS replication, rolbypassrls AS bypassrls
       FROM pg_catalog.pg_roles WHERE rolname = current_user`,
  );
  const me = rows[0];
  if (me === undefined) return ['the connected role was not found in pg_roles'];
  const problems: string[] = [];
  for (const [flag, label] of [
    [me.superuser, 'is a superuser'],
    [me.createrole, 'has CREATEROLE'],
    [me.createdb, 'has CREATEDB'],
    [me.replication, 'has REPLICATION'],
    [me.bypassrls, 'has BYPASSRLS'],
  ] as const) {
    if (flag) problems.push(`${me.role} ${label}`);
  }

  const held = await memberships(q, me.role);
  const direct = held.filter((m) => m.direct).map((m) => m.name);
  if (direct.length !== 1 || direct[0] !== group) {
    problems.push(`${me.role} must be a member of ${group} only, but is a member of: ${direct.join(', ') || 'nothing'}`);
  }
  const inherited = held.filter((m) => !m.direct).map((m) => m.name);
  if (inherited.length > 0) problems.push(`${group} is itself a member of: ${inherited.join(', ')}`);
  const privileged = held.filter((m) => m.privileged).map((m) => m.name);
  if (privileged.length > 0) problems.push(`${me.role} can SET ROLE to privileged role(s): ${privileged.join(', ')}`);
  const admin = await adminOptions(q, me.role);
  if (admin.length > 0) problems.push(`${me.role} holds ADMIN OPTION on: ${admin.join(', ')}`);

  const grants = await directGrants(q, me.role);
  if (grants.length > 0) problems.push(`${me.role} holds privileges of its own, beyond ${group}: ${grants.slice(0, 5).join('; ')}${grants.length > 5 ? '; ...' : ''}`);
  const settings = await savedSettings(q, me.role);
  if (settings.length > 0) problems.push(`${me.role} has saved settings (${settings.map((s) => s ?? 'all databases').join(', ')}); run pnpm db:roles to reset them`);

  const owned = Number((await q.query<{ owned: number | string }>(OWNED_OBJECTS, [me.role])).rows[0]?.owned ?? 0);
  if (owned > 0) problems.push(`${me.role} owns (or can act as the owner of) ${owned} objects in this database, so it could disable triggers or change the schema`);

  const { rows: tables } = await q.query<{ table: string } & Record<(typeof CHECKED_PRIVILEGES)[number] | 'SELECT', boolean>>(TABLE_PRIVILEGE_CHECK);
  const unreadable = tables.filter((t) => !t.SELECT).map((t) => t.table);
  if (unreadable.length > 0) problems.push(`${me.role} cannot read ${unreadable.join(', ')}; run pnpm db:roles (or pnpm db:migrate) to re-apply grants`);
  for (const t of tables) {
    const allowed = new Set(runtimePrivilegesFor(t.table));
    const extra = CHECKED_PRIVILEGES.filter((privilege) => t[privilege] && !allowed.has(privilege));
    if (extra.length > 0) problems.push(`${me.role} has ${extra.join(', ')} on ${t.table}, beyond least privilege`);
  }

  const { rows: creatable } = await q.query<{ schema: string }>(
    `SELECT nspname AS schema FROM pg_catalog.pg_namespace
      WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' AND pg_catalog.has_schema_privilege(nspname, 'CREATE')
      ORDER BY 1`,
  );
  if (creatable.length > 0) problems.push(`${me.role} can create objects in schema(s): ${creatable.map((s) => s.schema).join(', ')}`);
  const database = (await q.query<{ create: boolean }>("SELECT pg_catalog.has_database_privilege(current_database(), 'CREATE') AS create")).rows[0];
  if (database?.create) problems.push(`${me.role} can create schemas in this database`);
  return problems;
}
