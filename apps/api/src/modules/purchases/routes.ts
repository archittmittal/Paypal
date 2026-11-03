import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseRequest } from '../../http/errors.js';
import { PurchaseError, type PurchaseErrorCode, type PurchaseService } from './service.js';

const SubmitBodySchema = z.strictObject({
  // VERIFY/#10 follow-up: there is no authentication yet, so the requester is named in the body and only
  // checked against the mandate's organization. Real auth must replace this before anything public.
  requesterUserId: z.uuid(),
  text: z.string().trim().min(1).max(4000),
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
});

const MandateParamsSchema = z.strictObject({ mandateId: z.uuid() });
const PurchaseParamsSchema = z.strictObject({ purchaseId: z.uuid() });

const STATUS: Record<PurchaseErrorCode, number> = {
  NOT_FOUND: 404,
  MANDATE_NOT_FOUND: 404,
  REQUESTER_NOT_ALLOWED: 403,
  REQUEST_KEY_CONFLICT: 409,
  INVALID_STATE: 409,
  PAYMENT_NOT_CAPTURABLE: 409,
};

function sendPurchaseError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (!(error instanceof PurchaseError)) throw error;
  return reply.status(STATUS[error.code]).send({ error: error.code, message: 'Request rejected', requestId: request.id });
}

export function purchaseRoutes(service: PurchaseService) {
  return (app: FastifyInstance): void => {
    app.post('/mandates/:mandateId/purchases', async (request, reply) => {
      const { mandateId } = parseRequest(MandateParamsSchema, request.params);
      const body = parseRequest(SubmitBodySchema, request.body);
      try {
        const { view, created } = await service.submit({ mandateId, ...body });
        return await reply.status(created ? 201 : 200).send(view);
      } catch (error) {
        return sendPurchaseError(error, request, reply);
      }
    });

    app.get('/purchases/:purchaseId', async (request, reply) => {
      const { purchaseId } = parseRequest(PurchaseParamsSchema, request.params);
      try {
        return await reply.send(await service.get(purchaseId));
      } catch (error) {
        return sendPurchaseError(error, request, reply);
      }
    });

    app.post('/purchases/:purchaseId/capture', async (request, reply) => {
      const { purchaseId } = parseRequest(PurchaseParamsSchema, request.params);
      try {
        return await reply.send(await service.capture(purchaseId));
      } catch (error) {
        return sendPurchaseError(error, request, reply);
      }
    });
  };
}
