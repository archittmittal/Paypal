import { AnthropicAdapter, LlmClient, LlmConfigError, LlmIntentParser, LlmRanker, loadLlmConfig, type Logger, type ProviderAdapter } from '@mandate/llm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from './db/db.js';
import { FixtureCatalog } from './modules/catalog/fixture.js';
import { paypalGatewayFromEnv } from './modules/payments/gateway.js';
import { PurchaseService } from './modules/purchases/service.js';
import { PaypalWebhookHandler } from './modules/webhooks/paypal.js';

export type Env = Readonly<Record<string, string | undefined>>;

export interface ComposeOptions {
  env: Env;
  db?: Db;
  log: Pick<FastifyBaseLogger, 'debug' | 'info' | 'warn' | 'error'>;
  /** Tests inject a scripted provider; production builds the Anthropic adapter from LLM config. */
  llmAdapter?: ProviderAdapter;
  /** Tests inject a fake fetch for PayPal. */
  paypalFetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** A feature that is off, and the variable names (never values) that would turn it on. */
export interface Disabled {
  feature: 'purchases' | 'paypal-webhooks';
  missing: readonly string[];
}

export interface Composition {
  purchases?: PurchaseService;
  paypalWebhooks?: PaypalWebhookHandler;
  disabled: Disabled[];
}

/** pino takes (fields, message); the LLM layer's Logger takes (message, fields). Fields are metadata only. */
export function llmLogger(log: ComposeOptions['log']): Logger {
  return {
    debug: (message, fields) => log.debug(fields, message),
    info: (message, fields) => log.info(fields, message),
    warn: (message, fields) => log.warn(fields, message),
    error: (message, fields) => log.error(fields, message),
  };
}

/**
 * The composition root. Each feature is wired only when all of its configuration is present, so the API
 * still starts (health, readiness) on a partial setup and says exactly what is missing. The catalog is the
 * offline fixture until Channel3 is verified (#16).
 */
export function compose(options: ComposeOptions): Composition {
  const { env, db, log } = options;
  const missing: string[] = db ? [] : ['DATABASE_URL'];

  let client: LlmClient | undefined;
  try {
    const config = loadLlmConfig(env);
    client = new LlmClient({
      adapter: options.llmAdapter ?? AnthropicAdapter.fromConfig(config),
      timeoutMs: config.timeoutMs,
      maxOutputTokens: config.maxOutputTokens,
      logger: llmLogger(log),
    });
  } catch (error) {
    if (!(error instanceof LlmConfigError)) throw error;
    missing.push(...error.variables);
  }

  const paypal = paypalGatewayFromEnv(env, options.paypalFetch);
  if (!paypal.ok) missing.push(...paypal.variables);

  if (!db || !client || !paypal.ok) {
    return {
      disabled: [
        { feature: 'purchases', missing },
        { feature: 'paypal-webhooks', missing: [...missing, 'PAYPAL_WEBHOOK_ID'] },
      ],
    };
  }

  const purchases = new PurchaseService({
    db,
    intentParser: new LlmIntentParser(client),
    catalog: new FixtureCatalog({ onDropped: (count) => log.warn({ count }, 'catalog.dropped') }),
    ranker: new LlmRanker(client),
    payments: paypal.gateway,
  });
  if (!paypal.webhooksEnabled) return { purchases, disabled: [{ feature: 'paypal-webhooks', missing: ['PAYPAL_WEBHOOK_ID'] }] };
  return { purchases, paypalWebhooks: new PaypalWebhookHandler({ db, payments: paypal.gateway, purchases }), disabled: [] };
}
