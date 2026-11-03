import type { FastifyInstance } from 'fastify';

/** A dependency the API needs before it can serve traffic, such as Postgres. */
export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

export const READINESS_TIMEOUT_MS = 2_000;

async function runCheck(check: ReadinessCheck, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  try {
    await Promise.race([check.check(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `/health`: the process is up (Render's health check). `/ready`: every dependency answered in time.
 * Failures report only the check name, never the error, which could include connection strings.
 */
export function healthRoutes(checks: readonly ReadinessCheck[], timeoutMs = READINESS_TIMEOUT_MS) {
  return (app: FastifyInstance): void => {
    app.get('/health', () => ({ status: 'ok' }));

    app.get('/ready', async (request, reply) => {
      const results = await Promise.all(checks.map(async (c) => [c.name, await runCheck(c, timeoutMs)] as const));
      const failed = results.filter(([, ok]) => !ok).map(([name]) => name);
      if (failed.length > 0) request.log.warn({ failed }, 'readiness check failed');
      return reply
        .status(failed.length > 0 ? 503 : 200)
        .send({
          status: failed.length > 0 ? 'not_ready' : 'ready',
          checks: Object.fromEntries(results.map(([name, ok]) => [name, ok ? 'ok' : 'fail'])),
        });
    });
  };
}
