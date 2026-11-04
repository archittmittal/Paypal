import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { Queryable, TransactionClient } from './pool.js';

/** The NOLOGIN group role migration 0005 grants runtime privileges to. */
export const RUNTIME_ROLE = 'mandate_runtime';

const ROLE_NAME = /^[a-z_][a-z0-9_]{2,62}$/;
// Printable ASCII only: SASLprep (RFC 4013) is then the identity, so the verifier below matches what libpq sends.
const PASSWORD = /^[\x21-\x7e]{16,256}$/;
const SCRAM_ITERATIONS = 4096;

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

/** The identifier is validated against ROLE_NAME first, so quoting it is belt and braces. */
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export interface ProvisionResult {
  role: string;
  created: boolean;
  /** Memberships the role had beyond mandate_runtime, now revoked (none of them privileged, or it would have failed). */
  revokedMemberships: string[];
  /** Saved per-role settings removed: 'all databases' or a database name (final verification, Low finding 1). */
  resetSettings: string[];
}

/** Provisioning refused to touch a role. Nothing was changed: provisioning runs in one transaction. */
export class RoleProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleProvisioningError';
  }
}

/**
 * Roles a member inherits (or can SET ROLE to) through `role`, transitively, with whether each one is privileged:
 * a predefined pg_* role (pg_write_server_files, pg_execute_server_program, ...) or a role with an attribute that
 * defeats least privilege. Used both before provisioning and by runtimeRoleProblems().
 */
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

async function memberships(client: Queryable, role: string): Promise<Membership[]> {
  return (await client.query<Membership>(MEMBERSHIP_CLOSURE, [role])).rows;
}

/** Objects in the current database owned by `role` or by any role it is a member of (it could act as their owner). */
const OWNED_OBJECTS = `
  SELECT (SELECT count(*) FROM pg_catalog.pg_class c WHERE pg_catalog.pg_has_role($1, c.relowner, 'MEMBER'))
       + (SELECT count(*) FROM pg_catalog.pg_proc p WHERE pg_catalog.pg_has_role($1, p.proowner, 'MEMBER'))
       + (SELECT count(*) FROM pg_catalog.pg_namespace n WHERE pg_catalog.pg_has_role($1, n.nspowner, 'MEMBER'))
       + (SELECT count(*) FROM pg_catalog.pg_type t WHERE pg_catalog.pg_has_role($1, t.typowner, 'MEMBER'))
       + (SELECT count(*) FROM pg_catalog.pg_database d WHERE d.datname = current_database() AND pg_catalog.pg_has_role($1, d.datdba, 'MEMBER'))
       AS owned`;

/**
 * Privileges granted to `role` itself, rather than through mandate_runtime (third review, M3): table, column, schema,
 * function, type, large-object, default and parameter ACLs in this database, and database ACLs cluster-wide. A
 * direct grant such as TRIGGER or UPDATE on a table would let the login bypass the rules mandate_runtime is held to.
 * Per-database catalogs of *other* databases are not visible from here.
 */
const DIRECT_GRANTS = `
  WITH acl(kind, name, grantee, privilege) AS (
    SELECT 'table', c.oid::regclass::text, a.grantee, a.privilege_type FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
    UNION ALL SELECT 'column', c.oid::regclass::text || '.' || att.attname, a.grantee, a.privilege_type
      FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid = att.attrelid, aclexplode(att.attacl) a
    UNION ALL SELECT 'schema', n.nspname, a.grantee, a.privilege_type FROM pg_catalog.pg_namespace n, aclexplode(n.nspacl) a
    UNION ALL SELECT 'function', p.oid::regprocedure::text, a.grantee, a.privilege_type FROM pg_catalog.pg_proc p, aclexplode(p.proacl) a
    UNION ALL SELECT 'type', t.oid::regtype::text, a.grantee, a.privilege_type FROM pg_catalog.pg_type t, aclexplode(t.typacl) a
    UNION ALL SELECT 'database', d.datname, a.grantee, a.privilege_type FROM pg_catalog.pg_database d, aclexplode(d.datacl) a
    UNION ALL SELECT 'large object', l.oid::text, a.grantee, a.privilege_type FROM pg_catalog.pg_largeobject_metadata l, aclexplode(l.lomacl) a
    UNION ALL SELECT 'parameter', pa.parname, a.grantee, a.privilege_type FROM pg_catalog.pg_parameter_acl pa, aclexplode(pa.paracl) a
    UNION ALL SELECT 'default privileges', d.defaclobjtype::text, a.grantee, a.privilege_type FROM pg_catalog.pg_default_acl d, aclexplode(d.defaclacl) a
  )
  SELECT kind || ' ' || name || ': ' || privilege AS grant
    FROM acl
   WHERE grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
   ORDER BY 1`;

async function directGrants(client: Queryable, role: string): Promise<string[]> {
  return (await client.query<{ grant: string }>(DIRECT_GRANTS, [role])).rows.map((r) => r.grant);
}

/** The functions that create large objects. PostgreSQL has no privilege for creating them other than EXECUTE on these. */
export const LARGE_OBJECT_CREATORS = [
  'pg_catalog.lo_creat(integer)',
  'pg_catalog.lo_create(oid)',
  'pg_catalog.lo_from_bytea(oid, bytea)',
  'pg_catalog.lo_import(text)',
  'pg_catalog.lo_import(text, oid)',
] as const;

/**
 * Revokes EXECUTE on the large-object creators from PUBLIC in the connected database, so mandate_runtime cannot fill
 * the database with large objects. Only a superuser can: the functions belong to the bootstrap superuser. Migration
 * 0007 does this itself when it runs as a superuser; `pnpm db:harden` covers deployments that migrate as a plain owner.
 * Idempotent. Returns the functions PUBLIC can still execute afterwards, which must be none.
 */
export async function hardenDatabase(client: Queryable): Promise<string[]> {
  const who = await client.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user');
  if (who.rows[0]?.rolsuper !== true) throw new RoleProvisioningError('db:harden must run as a superuser (DATABASE_SUPERUSER_URL)');
  await client.query(`REVOKE EXECUTE ON FUNCTION ${LARGE_OBJECT_CREATORS.join(', ')} FROM PUBLIC`);
  return publicLargeObjectCreators(client);
}

/** Large-object creators PUBLIC can still execute in the connected database. */
export async function publicLargeObjectCreators(client: Queryable): Promise<string[]> {
  const { rows } = await client.query<{ fn: string; open: boolean }>(
    `SELECT f AS fn, pg_catalog.has_function_privilege('public', f::regprocedure, 'EXECUTE') AS open FROM unnest($1::text[]) AS f`,
    [LARGE_OBJECT_CREATORS],
  );
  return rows.filter((r) => r.open).map((r) => r.fn);
}

/**
 * Where `role` has saved settings (pg_db_role_setting): null for "all databases", otherwise a database name. Any role
 * may save settings on itself, so a compromised login can leave a search_path or timeout behind for every later
 * session (final verification, Low finding 1). Database-wide settings (ALTER DATABASE ... SET) are not included.
 */
async function savedSettings(client: Queryable, role: string): Promise<(string | null)[]> {
  const { rows } = await client.query<{ datname: string | null }>(
    `SELECT d.datname FROM pg_catalog.pg_db_role_setting s LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
      WHERE s.setrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1) ORDER BY 1 NULLS FIRST`,
    [role],
  );
  return rows.map((r) => r.datname);
}

/**
 * Other databases on this cluster that PUBLIC may connect to, and that the runtime login can therefore reach with
 * whatever those databases grant PUBLIC (temp tables, large objects). Roles are cluster-wide; Mandate databases grant
 * CONNECT to mandate_runtime only (0006), so they are not listed (final verification, Low finding 2). The default
 * `postgres` and `template1` are listed until `pnpm db:harden` restricts them.
 */
export async function publicConnectDatabases(client: Queryable): Promise<string[]> {
  const { rows } = await client.query<{ datname: string }>(
    `SELECT datname FROM pg_catalog.pg_database
      WHERE datallowconn AND datname <> current_database() AND pg_catalog.has_database_privilege('public', oid, 'CONNECT')
      ORDER BY 1`,
  );
  return rows.map((r) => r.datname);
}

/** The cluster's default databases, which `pnpm db:harden` closes to PUBLIC. Other databases are reported, never changed. */
export const DEFAULT_DATABASES = ['postgres', 'template1'] as const;

/**
 * Revokes CONNECT from PUBLIC on the given databases (superuser, or each database's owner). Owners, superusers and
 * roles granted CONNECT explicitly keep it; CREATE DATABASE from template1 does not need CONNECT on it.
 */
export async function restrictPublicConnect(client: Queryable, databases: readonly string[]): Promise<void> {
  for (const database of databases) await client.query(`REVOKE CONNECT ON DATABASE ${ident(database)} FROM PUBLIC`);
}

/**
 * Creates or updates the LOGIN role the API connects as, so that afterwards it has no attributes beyond LOGIN and
 * is a member of mandate_runtime and nothing else (findings M1, L6). Run as the database owner or an administrator
 * (`pnpm db:roles`). Like every role it belongs to the whole cluster; its privileges live in each Mandate database
 * through migrations 0005 and 0006.
 *
 * Everything runs in one transaction and is checked before anything changes: an existing role that is privileged
 * (SUPERUSER, CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS), is a member of a privileged role directly or
 * transitively, owns objects in this database, or holds privileges granted to it directly is refused and left
 * exactly as it was. Other memberships are
 * revoked. The final membership set is then read back and must be exactly {mandate_runtime}.
 */
export async function provisionLoginRole(client: TransactionClient, role: string, password: string): Promise<ProvisionResult> {
  if (!ROLE_NAME.test(role) || role === RUNTIME_ROLE) throw new RangeError(`role must match ${String(ROLE_NAME)} and differ from ${RUNTIME_ROLE}`);
  const verifier = literal(scramVerifier(password));
  await client.query('BEGIN');
  try {
    const result = await provisionInTransaction(client, role, verifier);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function provisionInTransaction(client: TransactionClient, role: string, verifier: string): Promise<ProvisionResult> {
  const runtime = await client.query<{ clean: boolean }>(
    `SELECT NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolcanlogin) AS clean
       FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [RUNTIME_ROLE],
  );
  const runtimeRow = runtime.rows[0];
  if (runtimeRow === undefined) throw new RoleProvisioningError(`role ${RUNTIME_ROLE} is missing; run pnpm db:migrate first`);
  if (!runtimeRow.clean) throw new RoleProvisioningError(`role ${RUNTIME_ROLE} has LOGIN or a privileged attribute`);
  const runtimeMemberships = await memberships(client, RUNTIME_ROLE);
  if (runtimeMemberships.length > 0) {
    throw new RoleProvisioningError(`role ${RUNTIME_ROLE} must be a member of no role, but is a member of: ${runtimeMemberships.map((m) => m.name).join(', ')}`);
  }

  const existing = await client.query<{ privileged: boolean }>(
    `SELECT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AS privileged FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [role],
  );
  const current = existing.rows[0];
  let revoked: string[] = [];
  const reset: string[] = [];
  const attributes = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT';
  if (current === undefined) {
    await client.query(`CREATE ROLE ${ident(role)} ${attributes} PASSWORD ${verifier}`);
  } else {
    // Refuse before changing anything (finding L6): demoting a role someone made privileged is their decision.
    if (current.privileged) throw new RoleProvisioningError(`existing role ${role} has a privileged attribute; refusing to reuse it`);
    const held = await memberships(client, role);
    const privileged = held.filter((m) => m.privileged).map((m) => m.name);
    if (privileged.length > 0) {
      throw new RoleProvisioningError(`existing role ${role} is a member of privileged role(s) ${privileged.join(', ')}; refusing to reuse it`);
    }
    const owned = await client.query<{ owned: number }>(OWNED_OBJECTS, [role]);
    if ((owned.rows[0]?.owned ?? 0) > 0) throw new RoleProvisioningError(`existing role ${role} owns objects in this database; refusing to reuse it`);
    const grants = await directGrants(client, role);
    if (grants.length > 0) {
      throw new RoleProvisioningError(`existing role ${role} holds privileges of its own (${grants.slice(0, 5).join('; ')}${grants.length > 5 ? '; ...' : ''}); refusing to reuse it`);
    }
    // Only LOGIN, INHERIT and the password change. The privileged attributes were just read as off, and naming
    // them at all (even NOSUPERUSER or NOREPLICATION) needs that privilege, which a CREATEROLE-only admin lacks.
    await client.query(`ALTER ROLE ${ident(role)} LOGIN INHERIT PASSWORD ${verifier}`);
    revoked = held.filter((m) => m.direct && m.name !== RUNTIME_ROLE).map((m) => m.name);
    for (const name of revoked) await client.query(`REVOKE ${ident(name)} FROM ${ident(role)} CASCADE`);
    // A login may save defaults on itself (ALTER ROLE CURRENT_USER SET search_path = ...), and they apply to every
    // later session, surviving restarts. Provisioning starts the role from none.
    for (const scope of await savedSettings(client, role)) {
      await client.query(scope === null ? `ALTER ROLE ${ident(role)} RESET ALL` : `ALTER ROLE ${ident(role)} IN DATABASE ${ident(scope)} RESET ALL`);
      reset.push(scope ?? 'all databases');
    }
    const left = await savedSettings(client, role);
    if (left.length > 0) throw new RoleProvisioningError(`could not reset saved settings of role ${role}`);
  }
  await client.query(`GRANT ${ident(RUNTIME_ROLE)} TO ${ident(role)}`);

  // Postconditions. A REVOKE of a membership another grantor made can be a no-op with only a warning, so read back.
  const attributesAfter = await client.query<{ privileged: boolean; login: boolean }>(
    `SELECT (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls) AS privileged, rolcanlogin AS login FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [role],
  );
  if (attributesAfter.rows[0]?.privileged !== false || attributesAfter.rows[0]?.login !== true) {
    throw new RoleProvisioningError(`role ${role} did not end up as a plain LOGIN role`);
  }
  const after = await memberships(client, role);
  const names = after.map((m) => m.name);
  if (names.length !== 1 || names[0] !== RUNTIME_ROLE) {
    throw new RoleProvisioningError(`role ${role} must be a member of ${RUNTIME_ROLE} only, but is a member of: ${names.join(', ')}`);
  }
  return { role, created: current === undefined, revokedMemberships: revoked, resetSettings: reset };
}

/**
 * Problems that would let the connected role act beyond least privilege. It checks an allowlist, not a denylist
 * (finding M1): no privileged attribute, memberships exactly {mandate_runtime}, none for mandate_runtime itself, no
 * privileges granted to the login role directly, no owned objects. Empty means none of these was found in this
 * database; it does not prove what mandate_runtime's own grants are (the privilege-matrix test does that). Intended for a startup check in the API (wiring it
 * in is outside issue #11). It covers the current database only: roles are cluster-wide, so what the login can do
 * in other databases on the same cluster is outside its view (finding M4, docs/er-diagram.md).
 */
export async function runtimeRoleProblems(client: Queryable): Promise<string[]> {
  const { rows } = await client.query<{
    role: string;
    superuser: boolean;
    createrole: boolean;
    createdb: boolean;
    replication: boolean;
    bypassrls: boolean;
    temp: boolean;
    public_connect: boolean;
    can_update_audit: boolean;
    can_delete_events: boolean;
    can_truncate_audit: boolean;
    can_write_mandates: boolean;
    can_write_limits: boolean;
  }>(`
    SELECT r.rolname                                                           AS role,
           r.rolsuper                                                          AS superuser,
           r.rolcreaterole                                                     AS createrole,
           r.rolcreatedb                                                       AS createdb,
           r.rolreplication                                                    AS replication,
           r.rolbypassrls                                                      AS bypassrls,
           pg_catalog.has_database_privilege(current_database(), 'TEMPORARY') AS temp,
           pg_catalog.has_database_privilege('public', current_database(), 'CONNECT') AS public_connect,
           pg_catalog.has_table_privilege('public.audit_log', 'UPDATE')        AS can_update_audit,
           pg_catalog.has_table_privilege('public.order_event', 'DELETE')      AS can_delete_events,
           pg_catalog.has_table_privilege('public.audit_log', 'TRUNCATE')      AS can_truncate_audit,
           (pg_catalog.has_table_privilege('public.mandate', 'INSERT')
             OR pg_catalog.has_column_privilege('public.mandate', 'budget_minor_units', 'UPDATE')
             OR pg_catalog.has_column_privilege('public.mandate', 'approver_user_id', 'UPDATE')) AS can_write_mandates,
           (pg_catalog.has_table_privilege('public.category_limit', 'INSERT')
             OR pg_catalog.has_table_privilege('public.category_limit', 'DELETE')
             OR pg_catalog.has_any_column_privilege('public.category_limit', 'UPDATE')) AS can_write_limits
      FROM pg_catalog.pg_roles r
     WHERE r.rolname = current_user`);
  const row = rows[0];
  if (row === undefined) return ['current_user not found in pg_roles'];
  const problems: string[] = [];
  for (const [flag, label] of [
    [row.superuser, 'is a superuser'],
    [row.createrole, 'has CREATEROLE'],
    [row.createdb, 'has CREATEDB'],
    [row.replication, 'has REPLICATION'],
    [row.bypassrls, 'has BYPASSRLS'],
  ] as const) {
    if (flag) problems.push(`${row.role} ${label}`);
  }

  const held = await memberships(client, row.role);
  const direct = held.filter((m) => m.direct).map((m) => m.name);
  if (direct.length !== 1 || direct[0] !== RUNTIME_ROLE) {
    problems.push(`${row.role} must be a member of ${RUNTIME_ROLE} only, but is a member of: ${direct.join(', ') || 'nothing'}`);
  }
  const inherited = held.filter((m) => !m.direct).map((m) => m.name);
  if (inherited.length > 0) problems.push(`${RUNTIME_ROLE} is itself a member of: ${inherited.join(', ')}`);

  const grants = await directGrants(client, row.role);
  if (grants.length > 0) problems.push(`${row.role} holds privileges of its own, beyond ${RUNTIME_ROLE}: ${grants.join('; ')}`);

  const owned = await client.query<{ owned: number }>(OWNED_OBJECTS, [row.role]);
  const ownedCount = owned.rows[0]?.owned ?? 0;
  if (ownedCount > 0) problems.push(`${row.role} owns (or can act as the owner of) ${ownedCount} objects in this database, so it can disable triggers`);
  if (row.temp) problems.push(`${row.role} can create temp tables`);
  const saved = await savedSettings(client, row.role);
  if (saved.length > 0) {
    problems.push(`${row.role} has saved settings (${saved.map((d) => d ?? 'all databases').join(', ')}) that apply to every session; run pnpm db:roles to reset them`);
  }
  const lo = await client.query<{ fn: string }>(
    `SELECT f AS fn FROM unnest($1::text[]) AS f WHERE pg_catalog.has_function_privilege(current_user, f::regprocedure, 'EXECUTE')`,
    [LARGE_OBJECT_CREATORS],
  );
  if (lo.rows.length > 0) problems.push(`${row.role} can create large objects (${lo.rows.map((r) => r.fn).join(', ')}); run pnpm db:harden as a superuser`);
  if (row.public_connect) problems.push('PUBLIC can connect to this database; migration 0006 restricts CONNECT to mandate_runtime');
  if (row.can_update_audit || row.can_delete_events || row.can_truncate_audit) problems.push(`${row.role} can modify append-only tables`);
  if (row.can_write_mandates || row.can_write_limits) problems.push(`${row.role} can write mandates or category limits directly, bypassing the admin functions`);
  return problems;
}
