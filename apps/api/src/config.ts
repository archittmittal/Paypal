import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const ApiEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  // Loopback by default so a laptop never exposes the API by accident. Render sets HOST=0.0.0.0.
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // Optional until the routes that need Postgres land; the API starts without it. Contains a password.
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/\S+$/).optional(),
});

export interface ApiConfig {
  port: number;
  host: string;
  logLevel: (typeof LOG_LEVELS)[number];
  databaseUrl?: string;
}

/** Names the invalid variables only. Values never appear in the message: some of them will be secrets. */
export class ApiConfigError extends Error {
  readonly variables: string[];

  constructor(variables: string[]) {
    super(`Invalid API configuration: ${variables.join(', ')}`);
    this.name = 'ApiConfigError';
    this.variables = variables;
  }
}

export function loadApiConfig(env: NodeJS.ProcessEnv): ApiConfig {
  // Empty strings count as unset, so `PORT=` in a .env falls back to the default instead of failing.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const result = ApiEnvSchema.safeParse(present);
  if (!result.success) {
    throw new ApiConfigError([...new Set(result.error.issues.map((issue) => String(issue.path[0])))]);
  }
  const { PORT, HOST, LOG_LEVEL, DATABASE_URL } = result.data;
  return { port: PORT, host: HOST, logLevel: LOG_LEVEL, ...(DATABASE_URL === undefined ? {} : { databaseUrl: DATABASE_URL }) };
}
