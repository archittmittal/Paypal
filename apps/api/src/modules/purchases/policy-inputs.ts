import type { History, Mandate } from '@mandate/policy';
import { toBigInt, type Queryable } from '../../db/db.js';

function toSafeNumber(value: unknown): number {
  const big = toBigInt(value);
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Database amount exceeds the safe integer range');
  }
  return Number(big);
}

interface MandateRow {
  id: string;
  status: Mandate['status'];
  currency: string;
  budget_minor_units: unknown;
  per_item_cap_minor_units: unknown;
  approval_threshold_minor_units: unknown;
  max_quantity_per_line: number;
  structuring_window_minutes: number;
  price_drift_tolerance_bps: number;
  starts_at: Date | string;
  ends_at: Date | string;
}

/**
 * Locks the mandate row and loads it with its category limits. Call inside a transaction: the lock is what
 * stops two concurrent requests from both passing the budget check (architecture failure mode 10).
 */
export async function lockMandate(tx: Queryable, mandateId: string): Promise<Mandate | undefined> {
  const { rows } = await tx.query<MandateRow>('SELECT * FROM mandate WHERE id = $1 FOR UPDATE', [mandateId]);
  const row = rows[0];
  if (!row) return undefined;
  const limits = await tx.query<{ category: string; allowed: boolean; cap_minor_units: unknown }>(
    'SELECT category, allowed, cap_minor_units FROM category_limit WHERE mandate_id = $1 ORDER BY category',
    [mandateId],
  );
  return {
    id: row.id,
    status: row.status,
    currency: row.currency,
    budgetMinor: toSafeNumber(row.budget_minor_units),
    perItemCapMinor: toSafeNumber(row.per_item_cap_minor_units),
    approvalThresholdMinor: toSafeNumber(row.approval_threshold_minor_units),
    maxQuantityPerLine: row.max_quantity_per_line,
    structuringWindowMinutes: row.structuring_window_minutes,
    priceDriftToleranceBps: row.price_drift_tolerance_bps,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    categoryLimits: limits.rows.map((limit) => ({
      category: limit.category,
      allowed: limit.allowed,
      ...(limit.cap_minor_units === null ? {} : { capMinor: toSafeNumber(limit.cap_minor_units) }),
    })),
  };
}

/**
 * Dated by the decision time, which the service clock sets, not by the row's created_at (the database clock):
 * the structuring window must use one clock, or recent purchases can fall outside it.
 *
 * Spend the policy engine counts: every HELD or COMMITTED reservation on the mandate, split into cart lines
 * (with product and category, for category caps and split-purchase detection) plus any remainder such as
 * shipping and tax.
 */
export async function loadHistory(tx: Queryable, mandateId: string): Promise<History> {
  const { rows } = await tx.query<{ at: Date | string; amount: unknown; currency: string; product_id: string | null; category: string | null }>(
    `SELECT pd.decided_at AS at, ci.line_total_minor_units AS amount, br.currency,
            ps.external_product_id AS product_id, ps.category
       FROM budget_reservation br
       JOIN policy_decision pd ON pd.id = br.policy_decision_id
       JOIN cart_item ci ON ci.cart_id = pd.cart_id
       JOIN product_snapshot ps ON ps.id = ci.product_snapshot_id
      WHERE br.mandate_id = $1 AND br.state IN ('HELD', 'COMMITTED')
     UNION ALL
     SELECT pd.decided_at, br.amount_minor_units - COALESCE(
              (SELECT SUM(ci.line_total_minor_units) FROM cart_item ci WHERE ci.cart_id = pd.cart_id), 0),
            br.currency, NULL, NULL
       FROM budget_reservation br
       JOIN policy_decision pd ON pd.id = br.policy_decision_id
      WHERE br.mandate_id = $1 AND br.state IN ('HELD', 'COMMITTED')`,
    [mandateId],
  );
  return {
    records: rows
      .map((row) => ({ row, amountMinor: toSafeNumber(row.amount) }))
      .filter(({ amountMinor }) => amountMinor > 0)
      .map(({ row, amountMinor }) => ({
        at: new Date(row.at),
        amountMinor,
        currency: row.currency,
        ...(row.product_id === null ? {} : { productId: row.product_id }),
        ...(row.category === null ? {} : { category: row.category }),
      })),
  };
}
