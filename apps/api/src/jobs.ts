import type { FastifyBaseLogger } from 'fastify';
import type { PurchaseService } from './modules/purchases/service.js';

/** How often expired approvals are swept and unknown payment outcomes reconciled. */
export const JOB_INTERVAL_MS = 60_000;

export interface Jobs {
  /** Runs one sweep-and-reconcile pass. A call while a pass is running joins that pass. */
  runOnce(): Promise<void>;
  /** Stops the timer and waits for a running pass, so shutdown never cuts a transaction short. */
  stop(): Promise<void>;
}

export interface JobOptions {
  log: Pick<FastifyBaseLogger, 'info' | 'error'>;
  intervalMs?: number;
}

/**
 * In-process background work for a **single instance** (render.yaml runs one). Passes never overlap within
 * the process, and a failure in one job is logged without stopping the other or the timer. sweepExpired
 * re-checks each approval under a row lock. reconcile() takes no lock: it re-reads PayPal's order and reuses
 * the original idempotency key, but two instances could still race on the same order, so do not scale out
 * before adding a lock (e.g. SELECT ... FOR UPDATE SKIP LOCKED) there.
 */
export function startJobs(purchases: Pick<PurchaseService, 'sweepExpired' | 'reconcileUnknown'>, options: JobOptions): Jobs {
  const { log } = options;
  let running: Promise<void> | undefined;

  const run = async (name: string, job: () => Promise<number>) => {
    try {
      const count = await job();
      if (count > 0) log.info({ job: name, count }, 'job.done');
    } catch (error) {
      log.error({ job: name, err: error }, 'job.failed');
    }
  };

  const runOnce = (): Promise<void> => {
    running ??= (async () => {
      await run('sweepExpired', () => purchases.sweepExpired());
      await run('reconcileUnknown', () => purchases.reconcileUnknown());
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  const timer = setInterval(() => void runOnce(), options.intervalMs ?? JOB_INTERVAL_MS);
  timer.unref();

  return {
    runOnce,
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
