import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const POSTGRES_URL = /^postgres(ql)?:\/\/\S+$/;

const ApiEnvSchema = z.object({
  // `production` turns on the fail-closed checks below and in the startup database gate (render.yaml sets it).
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  // Loopback by default so a laptop never exposes the API by accident. Render sets HOST=0.0.0.0.
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // The API's runtime login (docs/deployment-render.md: the restricted mandate_app role in production).
  // Required with NODE_ENV=production; optional in development, where features that need it stay off. Contains a password.
  DATABASE_URL: z.string().regex(POSTGRES_URL).optional(),
  // Comma-separated browser origins allowed to call the API (the web app). Unset: no cross-origin access.
  WEB_ORIGIN: z
    .string()
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean))
    .pipe(z.array(z.url({ protocol: /^https?$/ }).refine((url) => new URL(url).origin === url, 'Must be a bare origin')).min(1))
    .optional(),
  // Emergency override, never set by render.yaml: lets the API start in production although its database login
  // is privileged (e.g. the owner, when the database cannot create a restricted role). Logged at every start.
  MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME: z.enum(['0', '1']).default('0'),
});

/**
 * Variables that belong to the operator's migration and provisioning commands (pnpm db:migrate, db:roles, db:seed).
 * The API process must not hold them in production: they carry the database owner's credentials.
 */
export const PROVISIONING_VARIABLES = ['MIGRATION_DATABASE_URL', 'MANDATE_APP_DB_PASSWORD'] as const;

export interface ApiConfig {
  port: number;
  host: string;
  logLevel: (typeof LOG_LEVELS)[number];
  databaseUrl?: string;
  webOrigins?: string[];
  /** Present (true) only with NODE_ENV=production. */
  production?: true;
  /** Present (true) only when MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME=1. */
  allowPrivilegedRuntime?: true;
}

/** Names the invalid variables only. Values never appear in the message: some of them will be secrets. */
export class ApiConfigError extends Error {
  readonly variables: string[];

  constructor(variables: string[], reason?: string) {
    super(`Invalid API configuration: ${variables.join(', ')}${reason ? ` (${reason})` : ''}`);
    this.name = 'ApiConfigError';
    this.variables = variables;
  }
}

/** Drops unset and empty variables, so `PORT=` in a .env falls back to the default instead of failing. */
export function presentVariables(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''));
}

export function loadApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const present = presentVariables(env);
  const result = ApiEnvSchema.safeParse(present);
  if (!result.success) {
    throw new ApiConfigError([...new Set(result.error.issues.map((issue) => String(issue.path[0])))]);
  }
  const { NODE_ENV, PORT, HOST, LOG_LEVEL, DATABASE_URL, WEB_ORIGIN, MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME } = result.data;
  if (NODE_ENV === 'production') {
    // Fail closed: a production API without its database would pass the health check while unable to serve.
    if (DATABASE_URL === undefined) throw new ApiConfigError(['DATABASE_URL'], 'required with NODE_ENV=production');
    const misplaced = PROVISIONING_VARIABLES.filter((name) => name in present);
    if (misplaced.length > 0) {
      throw new ApiConfigError([...misplaced], 'provisioning credentials must not be set on the API service with NODE_ENV=production');
    }
  }
  return {
    port: PORT,
    host: HOST,
    logLevel: LOG_LEVEL,
    ...(DATABASE_URL === undefined ? {} : { databaseUrl: DATABASE_URL }),
    ...(WEB_ORIGIN === undefined ? {} : { webOrigins: WEB_ORIGIN }),
    ...(NODE_ENV === 'production' ? { production: true as const } : {}),
    ...(MANDATE_DB_ALLOW_PRIVILEGED_RUNTIME === '1' ? { allowPrivilegedRuntime: true as const } : {}),
  };
}
