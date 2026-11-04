import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BODY_LIMIT_BYTES, buildApp } from '../src/app.js';
import { parseRequest, RequestValidationError } from '../src/http/errors.js';
import { healthRoutes, type ReadinessCheck } from '../src/modules/health/routes.js';

const config = { logLevel: 'silent' as const };
let app: FastifyInstance | undefined;

async function build(readinessChecks: readonly ReadinessCheck[] = []): Promise<FastifyInstance> {
  app = await buildApp({ config, readinessChecks, logger: false });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('health', () => {
  it('reports the process is up', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('builds with the default logger', async () => {
    app = await buildApp({ config });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

describe('readiness', () => {
  it('is ready with no checks registered', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: {} });
  });

  it('returns 503 naming the failed check without leaking its error', async () => {
    const res = await (
      await build([
        { name: 'postgres', check: () => Promise.reject(new Error('connect ECONNREFUSED db.internal:5432 LEAK-MARKER')) },
        { name: 'other', check: () => Promise.resolve() },
      ])
    ).inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', checks: { postgres: 'fail', other: 'ok' } });
    expect(res.body).not.toContain('LEAK-MARKER');
  });

  it('fails a check that does not answer in time', async () => {
    app = (await import('fastify')).default({ logger: false });
    await app.register(healthRoutes([{ name: 'slow', check: () => new Promise(() => undefined) }], 20));
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', checks: { slow: 'fail' } });
  });
});

describe('errors', () => {
  it('returns a JSON 404 with a request id for unknown routes', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'NOT_FOUND', requestId: expect.stringMatching(UUID) as unknown });
  });

  it('sets x-request-id and ignores a client-supplied one', async () => {
    const res = await (await build()).inject({ method: 'GET', url: '/health', headers: { 'request-id': 'evil' } });
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('maps a Zod validation failure to 400 with paths and codes, not values', async () => {
    const a = await build();
    a.post('/echo', (request) => parseRequest(z.strictObject({ amountMinor: z.int() }), request.body));
    const res = await a.inject({ method: 'POST', url: '/echo', payload: { amountMinor: 'secret-ish' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'BAD_REQUEST', issues: [{ path: 'amountMinor', code: 'invalid_type' }] });
    expect(res.body).not.toContain('secret-ish');
  });

  it('hides internal error details behind a generic 500', async () => {
    const a = await build();
    a.get('/boom', () => {
      throw new Error('SELECT * FROM mandate; password=hunter2');
    });
    const res = await a.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: 'INTERNAL', message: 'Internal server error' });
    expect(res.body).not.toContain('hunter2');
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [418, 'CLIENT_ERROR'],
  ])('passes a %i through with a fixed message', async (status, name) => {
    const a = await build();
    a.get('/client', () => {
      throw Object.assign(new Error('detail that should stay server-side'), { statusCode: status });
    });
    const res = await a.inject({ method: 'GET', url: '/client' });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: name, message: 'Request rejected' });
  });

  it('rejects malformed JSON with 400', async () => {
    const a = await build();
    a.post('/echo', (request) => request.body);
    const res = await a.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload: '{"a":' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'BAD_REQUEST' });
  });

  it('rejects an oversized body with 413', async () => {
    const a = await build();
    a.post('/echo', (request) => request.body);
    const payload = JSON.stringify({ text: 'x'.repeat(BODY_LIMIT_BYTES) });
    const res = await a.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'application/json' }, payload });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'PAYLOAD_TOO_LARGE' });
  });

  it('rejects an unsupported content type with 415', async () => {
    const a = await build();
    a.post('/echo', (request) => request.body);
    const res = await a.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'text/xml' }, payload: '<a/>' });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ error: 'UNSUPPORTED_MEDIA_TYPE' });
  });
});

describe('parseRequest', () => {
  it('returns parsed data', () => {
    expect(parseRequest(z.object({ a: z.int() }), { a: 1 })).toEqual({ a: 1 });
  });

  it('joins nested paths', () => {
    try {
      parseRequest(z.object({ items: z.array(z.object({ q: z.int() })) }), { items: [{ q: 'x' }] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RequestValidationError);
      expect((error as RequestValidationError).issues).toEqual([{ path: 'items.0.q', code: 'invalid_type' }]);
    }
  });
});
