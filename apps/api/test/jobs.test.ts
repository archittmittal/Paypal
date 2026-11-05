import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_INTERVAL_MS, startJobs } from '../src/jobs.js';

function setup(overrides: { sweepExpired?: () => Promise<number>; reconcileUnknown?: () => Promise<number> } = {}) {
  const purchases = {
    sweepExpired: vi.fn(overrides.sweepExpired ?? (() => Promise.resolve(0))),
    reconcileUnknown: vi.fn(overrides.reconcileUnknown ?? (() => Promise.resolve(0))),
  };
  const log = { info: vi.fn(), error: vi.fn() };
  return { purchases, log, jobs: startJobs(purchases, { log, intervalMs: 1_000 }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('startJobs', () => {
  it('sweeps then reconciles, logging only when something changed', async () => {
    const { purchases, log, jobs } = setup({ sweepExpired: () => Promise.resolve(2) });
    await jobs.runOnce();
    expect(purchases.sweepExpired).toHaveBeenCalledTimes(1);
    expect(purchases.reconcileUnknown).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledExactlyOnceWith({ job: 'sweepExpired', count: 2 }, 'job.done');
    await jobs.stop();
  });

  it('keeps going when one job fails', async () => {
    const error = new Error('db down');
    const { purchases, log, jobs } = setup({ sweepExpired: () => Promise.reject(error) });
    await jobs.runOnce();
    expect(log.error).toHaveBeenCalledWith({ job: 'sweepExpired', err: error }, 'job.failed');
    expect(purchases.reconcileUnknown).toHaveBeenCalledTimes(1);
    await jobs.stop();
  });

  it('never overlaps passes: a second call joins the running one', async () => {
    let release: (count: number) => void = () => undefined;
    const { purchases, jobs } = setup({ sweepExpired: () => new Promise<number>((resolve) => (release = resolve)) });
    const first = jobs.runOnce();
    const second = jobs.runOnce();
    expect(second).toBe(first);
    release(0);
    await first;
    expect(purchases.sweepExpired).toHaveBeenCalledTimes(1);
    const next = jobs.runOnce();
    expect(next).not.toBe(first);
    release(0);
    await next;
    expect(purchases.sweepExpired).toHaveBeenCalledTimes(2);
    await jobs.stop();
  });

  it('runs on the timer and stops cleanly, waiting for a running pass', async () => {
    vi.useFakeTimers();
    const { purchases, jobs } = setup();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(purchases.sweepExpired).toHaveBeenCalledTimes(2);
    await jobs.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(purchases.sweepExpired).toHaveBeenCalledTimes(2);
  });

  it('defaults to a one-minute interval', async () => {
    vi.useFakeTimers();
    const purchases = { sweepExpired: vi.fn(() => Promise.resolve(0)), reconcileUnknown: vi.fn(() => Promise.resolve(0)) };
    const jobs = startJobs(purchases, { log: { info: vi.fn(), error: vi.fn() } });
    await vi.advanceTimersByTimeAsync(JOB_INTERVAL_MS - 1);
    expect(purchases.sweepExpired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(purchases.sweepExpired).toHaveBeenCalledTimes(1);
    await jobs.stop();
  });
});
