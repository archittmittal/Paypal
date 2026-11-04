import { type Money, MoneySchema } from '@mandate/shared';
import type { TransactionClient } from './pool.js';

export interface ReserveBudgetInput {
  mandateId: string;
  policyDecisionId: string;
  amount: Money;
  expiresAt: Date;
}

export type ReservationState = 'HELD' | 'RELEASED' | 'COMMITTED';

export type ReserveBudgetResult =
  /** A new hold was written. */
  | { ok: true; created: true; reservationId: string; reservedBeforeMinor: number; budgetMinor: number }
  /** A retry: this decision already has a hold for the same mandate and amount, which is still held or already spent. */
  | { ok: true; created: false; reservationId: string; state: 'HELD' | 'COMMITTED' }
  | { ok: false; reason: 'BUDGET_EXCEEDED'; reservedBeforeMinor: number; budgetMinor: number }
  | { ok: false; reason: 'CURRENCY_MISMATCH' | 'MANDATE_NOT_FOUND' | 'MANDATE_INACTIVE' | 'DECISION_NOT_FOUND' | 'DECISION_NOT_RESERVABLE' }
  /**
   * DECISION_ALREADY_RESERVED: the decision has a hold for another mandate, amount or currency.
   * RESERVATION_RELEASED: the decision's hold was released; a decision is held at most once, so make a new decision.
   */
  | { ok: false; reason: 'DECISION_ALREADY_RESERVED' | 'RESERVATION_RELEASED'; reservationId: string };

interface ExistingReservation {
  id: string;
  mandate_id: string;
  amount_minor_units: number;
  currency: string;
  state: ReservationState;
}

/**
 * Holds `amount` against the mandate budget, or reports why it cannot (docs/er-diagram.md, "Concurrency: budget
 * reservations"). Call it inside a READ COMMITTED transaction (`withTransaction`) together with the policy decision
 * it belongs to, so the lock covers both. Every rejection is a value, not an error, so the transaction stays usable.
 * It takes a single client, never a Pool (enforced by the type): on a pool each query could run on another
 * connection and the lock would be released before the sum and the insert.
 *
 * Idempotent on policyDecisionId (finding M3): a retry after an ambiguous COMMIT (CommitOutcomeUnknownError) returns
 * the hold the first attempt wrote, with created=false, instead of failing on the unique key. Only the mandate,
 * amount and currency must match; expiresAt of the retry is ignored.
 *
 * The mandate row lock serializes concurrent callers, including two retries of the same decision. The trigger
 * (migrations 0002, 0004, 0006) enforces the same invariant again for any writer that skips this function (MD001)
 * and refuses a reservation that does not match its policy decision (MD007); this function checks the decision
 * first so those cases come back as DECISION_NOT_RESERVABLE values rather than errors (finding L9).
 * `amount` may exceed the decision total, e.g. by the mandate's drift tolerance; on capture the reservation records
 * the captured amount (committed_amount_minor_units) and only that counts against the budget.
 */
export async function reserveBudget(client: TransactionClient, input: ReserveBudgetInput): Promise<ReserveBudgetResult> {
  const amount = MoneySchema.parse(input.amount);
  // uuid text from Postgres is lower case; compare like with like.
  const mandateId = input.mandateId.toLowerCase();
  if (Number.isNaN(input.expiresAt.getTime())) throw new RangeError('expiresAt is not a valid date');

  // "active" uses the database clock, as the trigger does, so the two can never disagree about the window.
  const mandate = await client.query<{ budget_minor_units: number; currency: string; active: boolean }>(
    `SELECT budget_minor_units, currency, (status = 'ACTIVE' AND now() >= starts_at AND now() < ends_at) AS active
       FROM public.mandate WHERE id = $1 FOR NO KEY UPDATE`,
    [input.mandateId],
  );
  const row = mandate.rows[0];
  if (row === undefined) return { ok: false, reason: 'MANDATE_NOT_FOUND' };

  // Under the lock, so a concurrent first attempt for this decision has either committed (and is seen here) or
  // not started.
  const existing = await findReservation(client, input.policyDecisionId);
  if (existing !== undefined) return replay(existing, mandateId, amount);

  if (row.currency !== amount.currency) return { ok: false, reason: 'CURRENCY_MISMATCH' };
  // The policy engine checks this too; re-checking under the lock catches a mandate paused since the decision.
  if (!row.active) return { ok: false, reason: 'MANDATE_INACTIVE' };

  const decision = await client.query<{ outcome: string; currency: string; total: number; mandate_id: string }>(
    `SELECT pd.outcome, pd.currency, pd.evaluated_total_minor_units AS total, pr.mandate_id
       FROM public.policy_decision AS pd
       JOIN public.purchase_request AS pr ON pr.id = pd.purchase_request_id
      WHERE pd.id = $1`,
    [input.policyDecisionId],
  );
  const scored = decision.rows[0];
  if (scored === undefined) return { ok: false, reason: 'DECISION_NOT_FOUND' };
  if (
    scored.outcome === 'DENY' ||
    scored.mandate_id !== mandateId ||
    scored.currency !== amount.currency ||
    amount.amountMinor < scored.total
  ) {
    return { ok: false, reason: 'DECISION_NOT_RESERVABLE' };
  }

  // COMMITTED rows count what was actually captured, HELD rows what they block (migration 0004).
  const active = await client.query<{ total: number }>('SELECT public.mandate_active_total($1) AS total', [input.mandateId]);
  const reservedBeforeMinor = active.rows[0]?.total ?? 0;
  if (reservedBeforeMinor + amount.amountMinor > row.budget_minor_units) {
    return { ok: false, reason: 'BUDGET_EXCEEDED', reservedBeforeMinor, budgetMinor: row.budget_minor_units };
  }

  // ON CONFLICT covers a writer that inserted for this decision without taking the mandate lock: the insert waits
  // for it, then does nothing, and the row it wrote is classified like any other retry.
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO public.budget_reservation (mandate_id, policy_decision_id, amount_minor_units, currency, state, expires_at)
     VALUES ($1, $2, $3, $4, 'HELD', $5)
     ON CONFLICT (policy_decision_id) DO NOTHING
     RETURNING id`,
    [input.mandateId, input.policyDecisionId, amount.amountMinor, amount.currency, input.expiresAt],
  );
  const id = inserted.rows[0]?.id;
  if (id !== undefined) return { ok: true, created: true, reservationId: id, reservedBeforeMinor, budgetMinor: row.budget_minor_units };
  const raced = await findReservation(client, input.policyDecisionId);
  if (raced === undefined) throw new Error('reservation conflict reported but no row found');
  return replay(raced, mandateId, amount);
}

async function findReservation(client: TransactionClient, policyDecisionId: string): Promise<ExistingReservation | undefined> {
  const { rows } = await client.query<ExistingReservation>(
    'SELECT id, mandate_id, amount_minor_units, currency, state FROM public.budget_reservation WHERE policy_decision_id = $1',
    [policyDecisionId],
  );
  return rows[0];
}

function replay(existing: ExistingReservation, mandateId: string, amount: Money): ReserveBudgetResult {
  if (existing.mandate_id !== mandateId || existing.amount_minor_units !== amount.amountMinor || existing.currency !== amount.currency) {
    return { ok: false, reason: 'DECISION_ALREADY_RESERVED', reservationId: existing.id };
  }
  if (existing.state === 'RELEASED') return { ok: false, reason: 'RESERVATION_RELEASED', reservationId: existing.id };
  return { ok: true, created: false, reservationId: existing.id, state: existing.state };
}
