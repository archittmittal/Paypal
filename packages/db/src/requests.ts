import { createHash } from 'node:crypto';
import type { TransactionClient } from './pool.js';

/** Same format the request_key column checks (migration 0001). */
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_RAW_TEXT = 4_000;

/** What a client sends when it raises a request. The requester and the key scope it; they are not part of it. */
export interface PurchaseRequestBody {
  mandateId: string;
  rawText: string;
}

/**
 * SHA-256 of the request body, as stored in purchase_request.request_hash. The input is a versioned JSON array of
 * plain strings, so it has one canonical serialization (no key ordering or whitespace to normalize). The mandate id
 * is a uuid and is lower-cased, so the same mandate written in either case is the same body. Text is hashed exactly
 * as received: two bodies that differ only in Unicode normalization are different bodies.
 */
export function requestBodyHash(body: PurchaseRequestBody): string {
  return createHash('sha256').update(JSON.stringify(['purchase_request.v1', body.mandateId.toLowerCase(), body.rawText])).digest('hex');
}

export interface CreatePurchaseRequestInput {
  requesterUserId: string;
  requestKey: string;
  body: PurchaseRequestBody;
}

export type CreatePurchaseRequestResult =
  /** created=false: a retry of a request already stored with the same key and the same body. */
  | { ok: true; created: boolean; requestId: string }
  | { ok: false; reason: 'REQUEST_KEY_REUSED' | 'MANDATE_NOT_FOUND' | 'REQUESTER_NOT_IN_ORGANIZATION' };

/**
 * Idempotent request creation (docs/er-diagram.md, request_key). Keys are scoped per requester. A retry with the
 * same key and body returns the first request; the same key with a different body is refused, never answered with
 * the other request. A requester outside the mandate's organization is refused (also enforced by composite foreign
 * keys from migration 0003). Rejections are values, so the caller's transaction stays usable.
 */
export async function createPurchaseRequest(client: TransactionClient, input: CreatePurchaseRequestInput): Promise<CreatePurchaseRequestResult> {
  const { requesterUserId, requestKey, body } = input;
  if (!REQUEST_KEY.test(requestKey)) throw new RangeError('requestKey must match /^[A-Za-z0-9_-]{8,128}$/');
  // Counted in code points, as Postgres's length() counts characters; .length would count UTF-16 units and refuse
  // text with emoji that the column accepts.
  const characters = [...body.rawText].length;
  if (characters === 0 || characters > MAX_RAW_TEXT) throw new RangeError(`rawText must be 1 to ${MAX_RAW_TEXT} characters`);
  const hash = requestBodyHash(body);

  const tenancy = await client.query<{ mandate_org: string; requester_org: string | null }>(
    `SELECT m.organization_id AS mandate_org, u.organization_id AS requester_org
       FROM public.mandate AS m
       LEFT JOIN public.app_user AS u ON u.id = $2
      WHERE m.id = $1`,
    [body.mandateId, requesterUserId],
  );
  const tenant = tenancy.rows[0];
  if (tenant === undefined) return { ok: false, reason: 'MANDATE_NOT_FOUND' };
  if (tenant.requester_org !== tenant.mandate_org) return { ok: false, reason: 'REQUESTER_NOT_IN_ORGANIZATION' };

  // A concurrent insert of the same key makes this wait for that transaction, then do nothing if it committed.
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO public.purchase_request (organization_id, mandate_id, requester_user_id, raw_text, request_key, request_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (requester_user_id, request_key) DO NOTHING
     RETURNING id`,
    [tenant.mandate_org, body.mandateId, requesterUserId, body.rawText, requestKey, hash],
  );
  const created = inserted.rows[0];
  if (created !== undefined) return { ok: true, created: true, requestId: created.id };

  const existing = await client.query<{ id: string; request_hash: string }>(
    'SELECT id, request_hash FROM public.purchase_request WHERE requester_user_id = $1 AND request_key = $2',
    [requesterUserId, requestKey],
  );
  const first = existing.rows[0];
  if (first === undefined) throw new Error('request_key conflict reported but no row found');
  return first.request_hash === hash ? { ok: true, created: false, requestId: first.id } : { ok: false, reason: 'REQUEST_KEY_REUSED' };
}
