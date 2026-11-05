import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseRequest } from '../../http/errors.js';
import { MandateError, type MandateErrorCode, type MandateService } from './service.js';

const ParamsSchema = z.strictObject({ mandateId: z.uuid() });
const Minor = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

const UpdateSchema = z.strictObject({
  // VERIFY/#10 follow-up: no authentication yet, so the actor is named in the body and must be an admin of the
  // mandate's organization. Real auth must replace this before anything public.
  actorUserId: z.uuid(),
  budgetMinor: Minor.optional(),
  perItemCapMinor: Minor.optional(),
  approvalThresholdMinor: Minor.optional(),
  maxQuantityPerLine: z.int().min(1).max(10_000).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'CLOSED']).optional(),
  categoryLimits: z
    .array(
      z.strictObject({
        category: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
        allowed: z.boolean(),
        capMinor: Minor.optional(),
      }),
    )
    .max(100)
    .refine((limits) => new Set(limits.map((l) => l.category)).size === limits.length, 'Duplicate category')
    .optional(),
});

const ListQuerySchema = z.strictObject({
  status: z
    .enum(['RECEIVED', 'NEEDS_CLARIFICATION', 'NO_MATCH', 'QUOTED', 'DENIED', 'PENDING_APPROVAL', 'REJECTED', 'EXPIRED', 'PAYMENT_PENDING', 'UNKNOWN_OUTCOME', 'CAPTURED', 'FAILED'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const STATUS: Record<MandateErrorCode, number> = { MANDATE_NOT_FOUND: 404, ACTOR_NOT_ALLOWED: 403 };

function sendMandateError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (!(error instanceof MandateError)) throw error;
  return reply.status(STATUS[error.code]).send({ error: error.code, message: 'Request rejected', requestId: request.id });
}

export function mandateRoutes(service: MandateService) {
  return (app: FastifyInstance): void => {
    app.get('/mandates/:mandateId', async (request, reply) => {
      const { mandateId } = parseRequest(ParamsSchema, request.params);
      try {
        return await reply.send(await service.get(mandateId));
      } catch (error) {
        return sendMandateError(error, request, reply);
      }
    });

    app.patch('/mandates/:mandateId', async (request, reply) => {
      const { mandateId } = parseRequest(ParamsSchema, request.params);
      const { actorUserId, ...change } = parseRequest(UpdateSchema, request.body);
      try {
        return await reply.send(await service.update(mandateId, actorUserId, change));
      } catch (error) {
        return sendMandateError(error, request, reply);
      }
    });

    app.get('/mandates/:mandateId/summary', async (request, reply) => {
      const { mandateId } = parseRequest(ParamsSchema, request.params);
      try {
        return await reply.send(await service.summary(mandateId));
      } catch (error) {
        return sendMandateError(error, request, reply);
      }
    });

    app.get('/mandates/:mandateId/purchases', async (request, reply) => {
      const { mandateId } = parseRequest(ParamsSchema, request.params);
      const query = parseRequest(ListQuerySchema, request.query);
      try {
        return await reply.send({ items: await service.purchases(mandateId, query) });
      } catch (error) {
        return sendMandateError(error, request, reply);
      }
    });
  };
}
