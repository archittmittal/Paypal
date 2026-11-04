import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiConfig } from './config.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { healthRoutes, type ReadinessCheck } from './modules/health/routes.js';
import { purchaseRoutes } from './modules/purchases/routes.js';
import type { PurchaseService } from './modules/purchases/service.js';

export interface AppOptions {
  config: Pick<ApiConfig, 'logLevel'>;
  readinessChecks?: readonly ReadinessCheck[];
  /** Registered only when the database and every port (LLM, catalog, PayPal) are configured. */
  purchases?: PurchaseService;
  /** Tests pass false to keep output quiet. */
  logger?: boolean;
}

/** Request bodies are small JSON documents; anything larger is refused before it is parsed. */
export const BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Builds the API without listening, so tests drive it with `app.inject`.
 * Modules (docs/architecture.md): intake, catalog, payments, approvals, audit, webhooks. Each registers its
 * routes here. Only `modules/payments` may import `@mandate/payments` (hard rule 1; see test/boundary.test.ts).
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: options.config.logLevel,
            // Credentials and webhook signatures must never reach the logs (hard rule 7).
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["paypal-transmission-sig"]'],
              censor: '[REDACTED]',
            },
          },
    bodyLimit: BODY_LIMIT_BYTES,
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  await app.register(healthRoutes(options.readinessChecks ?? []));
  if (options.purchases) await app.register(purchaseRoutes(options.purchases));
  return app;
}
