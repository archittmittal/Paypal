import { buildApp } from './app.js';
import { ApiConfigError, loadApiConfig } from './config.js';

// Entry point: `pnpm dev` (watch) or `pnpm --filter @mandate/api start`. Everything testable lives in app.ts.

let config;
try {
  config = loadApiConfig(process.env);
} catch (error) {
  if (error instanceof ApiConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const app = await buildApp({ config });

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}

await app.listen({ port: config.port, host: config.host });
