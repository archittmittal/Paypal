import { toBigInt, type Queryable } from './db.js';

export interface ReserveInput {
  mandateId: string;
  policyDecisionId: string;
  amountMinor: number;
  currency: string;
  expiresAt: Date;
}

export type ReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: 'MANDATE_NOT_FOUND' | 'CURRENCY_MISMATCH' | 'BUDGET_EXHAUSTED' };

/**
 * Holds budget for a decision (docs/er-diagram.md, "Concurrency: budget reservations").
 *
 * Call it inside `db.transaction`, ideally the same one that ran the policy check. The mandate row lock
 * serialises concurrent requests on one mandate, so committed + held spend can never pass the budget even
 * when two requests arrive together (architecture failure mode 10). The check here is a database-level
 * backstop: the policy engine should already have denied an over-budget cart.
 */
export async function reserveBudget(tx: Queryable, input: ReserveInput): Promise<ReserveResult> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
    throw new RangeError('amountMinor must be a non-negative safe integer');
  }
  const mandate = await tx.query<{ budget_minor_units: unknown; currency: string }>(
    'SELECT budget_minor_units, currency FROM mandate WHERE id = $1 FOR UPDATE',
    [input.mandateId],
  );
  const row = mandate.rows[0];
  if (!row) return { ok: false, reason: 'MANDATE_NOT_FOUND' };
  if (row.currency !== input.currency) return { ok: false, reason: 'CURRENCY_MISMATCH' };

  const active = await tx.query<{ total: unknown }>(
    "SELECT COALESCE(SUM(amount_minor_units), 0) AS total FROM budget_reservation WHERE mandate_id = $1 AND state IN ('HELD', 'COMMITTED')",
    [input.mandateId],
  );
  const reserved = toBigInt(active.rows[0]?.total ?? 0);
  if (reserved + BigInt(input.amountMinor) > toBigInt(row.budget_minor_units)) {
    return { ok: false, reason: 'BUDGET_EXHAUSTED' };
  }

  const inserted = await tx.query<{ id: string }>(
    'INSERT INTO budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [input.mandateId, input.policyDecisionId, input.amountMinor, input.currency, input.expiresAt],
  );
  // RETURNING always yields the inserted row.
  return { ok: true, reservationId: inserted.rows[0]!.id };
}

/** HELD -> RELEASED (rejected, expired or failed). Returns false if the reservation was not HELD. */
export async function releaseReservation(tx: Queryable, reservationId: string, now: Date): Promise<boolean> {
  const result = await tx.query(
    "UPDATE budget_reservation SET state = 'RELEASED', released_at = $2 WHERE id = $1 AND state = 'HELD' RETURNING id",
    [reservationId, now],
  );
  return result.rows.length === 1;
}

/** HELD -> COMMITTED (capture confirmed). Returns false if the reservation was not HELD. */
export async function commitReservation(tx: Queryable, reservationId: string): Promise<boolean> {
  const result = await tx.query(
    "UPDATE budget_reservation SET state = 'COMMITTED' WHERE id = $1 AND state = 'HELD' RETURNING id",
    [reservationId],
  );
  return result.rows.length === 1;
}
