import { inspect } from 'node:util';
import { z } from 'zod';

const REDACTED = '[REDACTED]';

/**
 * Holds the connection string, which carries the database password. Every serialization path prints
 * [REDACTED]; only reveal() returns the value. Same pattern as the Secret in packages/llm and packages/payments.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export interface DatabaseConfig {
  connectionString: Secret;
  /** host:port/database, never the user or password. Safe to print. */
  target: string;
  poolMax: number;
  connectTimeoutMs: number;
  /** Server-side cap on any single statement, so a stuck query cannot hold a lock forever. */
  statementTimeoutMs: number;
  /**
   * Server-side cap on a session sitting idle inside an open transaction (finding L7). A client that hangs between
   * statements would otherwise hold its row locks, such as the mandate lock every reservation takes, indefinitely.
   */
  idleInTransactionTimeoutMs: number;
}

/** Names only, never values: a value could be the password itself. */
export class DatabaseConfigError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(`Invalid database configuration: ${variables.join(', ')}`);
    this.name = 'DatabaseConfigError';
    this.variables = variables;
  }
}

const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);
const PG_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/;

// The POSTGRES_* defaults match docker-compose.yml, so a fresh clone works with no .env at all.
const PostgresUrl = z.preprocess(emptyAsUnset, z.url({ protocol: /^postgres(ql)?$/ }).optional());

const EnvSchema = z.object({
  DATABASE_URL: PostgresUrl,
  DATABASE_ADMIN_URL: PostgresUrl,
  DATABASE_SUPERUSER_URL: PostgresUrl,
  POSTGRES_USER: z.preprocess(emptyAsUnset, z.string().regex(PG_IDENTIFIER).default('mandate')),
  POSTGRES_PASSWORD: z.preprocess(emptyAsUnset, z.string().min(1).max(200).default('mandate')),
  POSTGRES_DB: z.preprocess(emptyAsUnset, z.string().regex(PG_IDENTIFIER).default('mandate')),
  POSTGRES_HOST: z.preprocess(emptyAsUnset, z.string().regex(/^[A-Za-z0-9.-]{1,253}$/).default('127.0.0.1')),
  POSTGRES_PORT: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(65_535).default(5432)),
  DATABASE_POOL_MAX: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(100).default(10)),
  DATABASE_CONNECT_TIMEOUT_MS: z.preprocess(emptyAsUnset, z.coerce.number().int().min(100).max(60_000).default(5_000)),
  DATABASE_STATEMENT_TIMEOUT_MS: z.preprocess(emptyAsUnset, z.coerce.number().int().min(100).max(600_000).default(30_000)),
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1_000).max(3_600_000).default(60_000)),
  NODE_ENV: z.preprocess(emptyAsUnset, z.string().optional()),
});

/** The only URL query parameter understood. Anything else is refused rather than silently ignored. */
const SSL_MODES = new Set(['disable', 'require', 'verify-ca', 'verify-full']);

/**
 * Who the connection is for. `runtime` is the API, which in a deployment logs in as the least-privilege role
 * (`pnpm db:roles`). `admin` is migrations, the seed and role provisioning, which need the owner. `superuser` is only
 * `pnpm db:harden` (DATABASE_SUPERUSER_URL, else the admin resolution), for the one change only a superuser can make.
 */
export type ConnectionPurpose = 'runtime' | 'admin' | 'superuser';

/**
 * The only place the db package reads configuration. Resolution order:
 *   runtime: DATABASE_URL, then POSTGRES_*
 *   admin:   DATABASE_ADMIN_URL, then DATABASE_URL, then POSTGRES_*
 * Locally none of the URLs is set and everything connects as the compose owner. In a deployment, DATABASE_URL is
 * the runtime role and DATABASE_ADMIN_URL the owner, so the API never holds credentials that can bypass append-only.
 *
 * Fails closed in production (NODE_ENV=production, any case; finding L10): the runtime needs DATABASE_URL and must
 * not be given DATABASE_ADMIN_URL at all, administration needs DATABASE_ADMIN_URL, there is no fallback to the
 * POSTGRES_* laptop defaults (which connect as the compose superuser), and the two URLs must log in as different
 * users. This is configuration hygiene, not proof of least privilege: that is runtimeRoleProblems(), which the API
 * should run at startup. Like every check here, it names variables, never values.
 */
export function loadDatabaseConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  purpose: ConnectionPurpose = 'runtime',
): DatabaseConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const variables = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'env')))].sort();
    throw new DatabaseConfigError(variables);
  }
  const data = parsed.data;
  if (data.NODE_ENV?.trim().toLowerCase() === 'production') {
    if (purpose === 'runtime' && data.DATABASE_URL === undefined) throw new DatabaseConfigError(['DATABASE_URL']);
    if (purpose === 'admin' && data.DATABASE_ADMIN_URL === undefined) throw new DatabaseConfigError(['DATABASE_ADMIN_URL']);
    if (purpose === 'superuser' && data.DATABASE_SUPERUSER_URL === undefined) throw new DatabaseConfigError(['DATABASE_SUPERUSER_URL']);
    if (purpose === 'runtime' && data.DATABASE_SUPERUSER_URL !== undefined) throw new DatabaseConfigError(['DATABASE_SUPERUSER_URL']);
    // The runtime process must not hold the owner credentials at all (third review, L3).
    if (purpose === 'runtime' && data.DATABASE_ADMIN_URL !== undefined) throw new DatabaseConfigError(['DATABASE_ADMIN_URL']);
    if (data.DATABASE_URL !== undefined && data.DATABASE_ADMIN_URL !== undefined && sameLogin(data.DATABASE_URL, data.DATABASE_ADMIN_URL)) {
      throw new DatabaseConfigError(['DATABASE_ADMIN_URL', 'DATABASE_URL']);
    }
  }
  const admin = data.DATABASE_ADMIN_URL ?? data.DATABASE_URL;
  const explicit = purpose === 'superuser' ? (data.DATABASE_SUPERUSER_URL ?? admin) : purpose === 'admin' ? admin : data.DATABASE_URL;
  const url = explicit === undefined ? buildUrl(data) : new URL(explicit);
  const variable =
    purpose === 'superuser' && data.DATABASE_SUPERUSER_URL !== undefined
      ? 'DATABASE_SUPERUSER_URL'
      : purpose !== 'runtime' && data.DATABASE_ADMIN_URL !== undefined
        ? 'DATABASE_ADMIN_URL'
        : 'DATABASE_URL';
  if (explicit !== undefined && !urlIsSupported(url)) throw new DatabaseConfigError([variable]);
  return {
    connectionString: new Secret(url.href),
    target: describeTarget(url),
    poolMax: data.DATABASE_POOL_MAX,
    connectTimeoutMs: data.DATABASE_CONNECT_TIMEOUT_MS,
    statementTimeoutMs: data.DATABASE_STATEMENT_TIMEOUT_MS,
    idleInTransactionTimeoutMs: data.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  };
}

/** Same user on the same server, whatever the password, query parameters or letter case of the host. */
function sameLogin(a: string, b: string): boolean {
  const [x, y] = [new URL(a), new URL(b)];
  return decodeURIComponent(x.username) === decodeURIComponent(y.username) && x.hostname.toLowerCase() === y.hostname.toLowerCase() && (x.port || '5432') === (y.port || '5432');
}

/** A host, a database name, and at most an sslmode parameter: everything connectionOptions() turns into pg options. */
function urlIsSupported(url: URL): boolean {
  if (url.hostname === '' || url.pathname.length < 2) return false;
  for (const [key, value] of url.searchParams) {
    if (key !== 'sslmode' || !SSL_MODES.has(value)) return false;
  }
  return true;
}

/** The pg connection settings for a config, as discrete fields. */
export interface ConnectionOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  /**
   * A function, not a string (finding L8): pg keeps its options on the Pool object, where util.inspect or a logger
   * would print a plain password. pg resolves the function at connect time and stores the result non-enumerable.
   */
  password: () => string;
  ssl: boolean;
}

/**
 * Splits the connection string into the fields pg needs. pg would merge a connection string over a password
 * function (an empty password in the URL wins), so the URL itself is never handed to pg.
 */
export function connectionOptions(config: DatabaseConfig): ConnectionOptions {
  const url = new URL(config.connectionString.reveal());
  const secret = new Secret(decodeURIComponent(url.password));
  const sslmode = url.searchParams.get('sslmode');
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port === '' ? 5432 : Number(url.port),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: () => secret.reveal(),
    // verify-ca is treated as verify-full: Node always checks the host name, which is the stricter reading.
    ssl: sslmode !== null && sslmode !== 'disable',
  };
}

function buildUrl(data: { POSTGRES_USER: string; POSTGRES_PASSWORD: string; POSTGRES_DB: string; POSTGRES_HOST: string; POSTGRES_PORT: number }): URL {
  const url = new URL('postgres://placeholder');
  url.username = encodeURIComponent(data.POSTGRES_USER);
  url.password = encodeURIComponent(data.POSTGRES_PASSWORD);
  url.hostname = data.POSTGRES_HOST;
  url.port = String(data.POSTGRES_PORT);
  url.pathname = `/${data.POSTGRES_DB}`;
  return url;
}

function describeTarget(url: URL): string {
  return `${url.hostname}:${url.port === '' ? '5432' : url.port}${url.pathname}`;
}

/** Returns the same config pointed at another database on the same server. Used by tests and admin tasks. */
export function withDatabase(config: DatabaseConfig, database: string): DatabaseConfig {
  if (!PG_IDENTIFIER.test(database)) throw new DatabaseConfigError(['database']);
  const url = new URL(config.connectionString.reveal());
  url.pathname = `/${database}`;
  return { ...config, connectionString: new Secret(url.href), target: describeTarget(url) };
}

/** Returns the same config logged in as another role. Used to connect as the least-privilege runtime role. */
export function withCredentials(config: DatabaseConfig, user: string, password: string): DatabaseConfig {
  if (!PG_IDENTIFIER.test(user)) throw new DatabaseConfigError(['user']);
  const url = new URL(config.connectionString.reveal());
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  return { ...config, connectionString: new Secret(url.href), target: describeTarget(url) };
}
