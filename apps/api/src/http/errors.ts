import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/** Thrown by `parseRequest`. Carries issue paths and codes only, never the rejected values. */
export class RequestValidationError extends Error {
  readonly issues: { path: string; code: string }[];

  constructor(issues: { path: string; code: string }[]) {
    super('Request validation failed');
    this.name = 'RequestValidationError';
    this.issues = issues;
  }
}

/** Validates untrusted request input (body, params, query) against a Zod schema. */
export function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RequestValidationError(
      result.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code })),
    );
  }
  return result.data;
}

export interface ErrorBody {
  error: string;
  message: string;
  requestId: string;
  issues?: { path: string; code: string }[];
}

/**
 * One place decides what a client sees. 4xx errors keep a short, fixed message; anything else becomes
 * a generic 500 so stack traces, SQL and provider payloads never leave the server. The full error is logged.
 */
export function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof RequestValidationError) {
    void reply
      .status(400)
      .send({ error: 'BAD_REQUEST', message: error.message, requestId: request.id, issues: error.issues } satisfies ErrorBody);
    return;
  }

  const status = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
  if (status >= 400 && status < 500) {
    request.log.info({ err: error }, 'client error');
    void reply.status(status).send({ error: clientErrorName(status), message: 'Request rejected', requestId: request.id } satisfies ErrorBody);
    return;
  }

  request.log.error({ err: error }, 'unhandled error');
  void reply.status(500).send({ error: 'INTERNAL', message: 'Internal server error', requestId: request.id } satisfies ErrorBody);
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  void reply.status(404).send({ error: 'NOT_FOUND', message: 'Route not found', requestId: request.id } satisfies ErrorBody);
}

function clientErrorName(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'CLIENT_ERROR';
  }
}
