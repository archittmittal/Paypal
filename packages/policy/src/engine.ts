import type { Money } from '@mandate/shared';
import { MoneySchema } from '@mandate/shared';
import type { z } from 'zod';
import { reason, type Reason } from './reasons.js';
import { CartSchema, HistorySchema, MandateSchema, type Cart, type History, type Mandate } from './schemas.js';

/** Recorded on every decision so eval runs and replays are comparable. Bump on any rule change. */
export const POLICY_VERSION = '0.1.0';

export type Outcome = 'ALLOW' | 'NEEDS_APPROVAL' | 'DENY';

export interface PolicyDecision {
  outcome: Outcome;
  reasons: Reason[];
  policyVersion: string;
  /** The exact total the engine saw, computed here from unit prices. Compare it with the capture amount. */
  evaluatedTotal: Money;
  decidedAt: Date;
}

/** Invalid input is a caller bug, not a policy outcome. Lists paths only, never the values. */
export class PolicyInputError extends Error {
  readonly paths: string[];

  constructor(message: string, paths: string[] = []) {
    super(paths.length > 0 ? `${message}: ${paths.join(', ')}` : message);
    this.name = 'PolicyInputError';
    this.paths = paths;
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PolicyInputError(
      `Invalid ${label}`,
      result.error.issues.map((issue) => [label, ...issue.path.map(String)].join('.')),
    );
  }
  return result.data;
}

function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/**
 * Decides whether a priced cart may be paid under a mandate. Pure: no I/O, no clock, no randomness.
 * Every rule runs, so a decision lists all of its reasons rather than the first one found.
 */
export function evaluate(mandateInput: Mandate, cartInput: Cart, historyInput: History, now: Date): PolicyDecision {
  const mandate = parse(MandateSchema, mandateInput, 'mandate');
  const cart = parse(CartSchema, cartInput, 'cart');
  const history = parse(HistorySchema, historyInput, 'history');
  if (Number.isNaN(now.getTime())) throw new PolicyInputError('Invalid now');
  if (history.records.some((record) => record.currency !== mandate.currency)) {
    throw new PolicyInputError('History must be in the mandate currency');
  }

  const reasons: Reason[] = [];
  const nowMs = now.getTime();

  if (mandate.status !== 'ACTIVE') {
    reasons.push(reason('MANDATE_INACTIVE', 'BLOCK', 'mandate.status', `The mandate is ${mandate.status.toLowerCase()}.`));
  }
  if (nowMs < mandate.startsAt.getTime() || nowMs >= mandate.endsAt.getTime()) {
    reasons.push(reason('MANDATE_INACTIVE', 'BLOCK', 'mandate.window', 'The mandate is outside its active dates.'));
  }
  if (cart.items.length === 0) {
    reasons.push(reason('EMPTY_CART', 'BLOCK', 'cart.items', 'The cart has no items.'));
  }

  const limits = new Map(mandate.categoryLimits.map((limit) => [limit.category, limit]));
  const lineTotals = cart.items.map((item) => BigInt(item.unitPriceMinor) * BigInt(item.quantity));
  const total = sum(lineTotals) + BigInt(cart.shippingMinor) + BigInt(cart.taxMinor);
  if (total > MAX_SAFE) throw new PolicyInputError('Cart total exceeds the largest safe integer');

  const blockedCategories = new Set<string>();
  cart.items.forEach((item, index) => {
    const line = index + 1;
    const limit = limits.get(item.category);
    if (limit?.allowed !== true && !blockedCategories.has(item.category)) {
      blockedCategories.add(item.category);
      reasons.push(
        reason('CATEGORY_NOT_ALLOWED', 'BLOCK', 'category.allowed', `Category "${item.category}" is not allowed by the mandate.`),
      );
    }
    if (item.quantity > mandate.maxQuantityPerLine) {
      reasons.push(
        reason('QUANTITY_IMPLAUSIBLE', 'BLOCK', 'line.quantity', `Line ${line}: quantity is above the mandate's per-line limit.`),
      );
    }
  });

  if (cart.currency !== mandate.currency) {
    // Amounts in different currencies cannot be compared, so the money rules below would be meaningless.
    reasons.push(
      reason('CURRENCY_MISMATCH', 'BLOCK', 'cart.currency', `The cart is in ${cart.currency} but the mandate is in ${mandate.currency}.`),
    );
  } else {
    reasons.push(...moneyRules(mandate, cart, history, lineTotals, total, nowMs));
  }

  const outcome: Outcome = reasons.some((r) => r.severity === 'BLOCK')
    ? 'DENY'
    : reasons.some((r) => r.severity === 'REVIEW')
      ? 'NEEDS_APPROVAL'
      : 'ALLOW';
  if (outcome === 'ALLOW') {
    reasons.push(reason('WITHIN_MANDATE', 'INFO', 'mandate', 'The cart is within every limit of the mandate.'));
  }

  return {
    outcome,
    reasons,
    policyVersion: POLICY_VERSION,
    evaluatedTotal: { amountMinor: Number(total), currency: cart.currency },
    decidedAt: new Date(nowMs),
  };
}

function moneyRules(
  mandate: Mandate,
  cart: Cart,
  history: History,
  lineTotals: bigint[],
  total: bigint,
  nowMs: number,
): Reason[] {
  const reasons: Reason[] = [];
  const perItemCap = BigInt(mandate.perItemCapMinor);
  const threshold = BigInt(mandate.approvalThresholdMinor);

  lineTotals.forEach((lineTotal, index) => {
    if (lineTotal > perItemCap) {
      reasons.push(
        reason('PER_ITEM_CAP_EXCEEDED', 'BLOCK', 'line.per_item_cap', `Line ${index + 1}: the line total is above the per-item cap.`),
      );
    }
  });

  // History holds committed spend and held reservations, so this is the budget-with-reservations check.
  const spent = sum(history.records.map((record) => BigInt(record.amountMinor)));
  if (spent + total > BigInt(mandate.budgetMinor)) {
    reasons.push(reason('BUDGET_EXHAUSTED', 'BLOCK', 'mandate.budget', 'This cart would take spending past the mandate budget.'));
  }

  const cartByCategory = new Map<string, bigint>();
  cart.items.forEach((item, index) => {
    cartByCategory.set(item.category, (cartByCategory.get(item.category) ?? 0n) + (lineTotals[index] ?? 0n));
  });
  for (const limit of mandate.categoryLimits) {
    const inCart = cartByCategory.get(limit.category);
    if (!limit.allowed || limit.capMinor === undefined || inCart === undefined) continue;
    const before = sum(history.records.filter((r) => r.category === limit.category).map((r) => BigInt(r.amountMinor)));
    if (before + inCart > BigInt(limit.capMinor)) {
      reasons.push(
        reason('CATEGORY_CAP_EXCEEDED', 'BLOCK', 'category.cap', `Spending on "${limit.category}" would go past its cap.`),
      );
    }
  }

  if (total >= threshold) {
    reasons.push(
      reason('THRESHOLD_EXCEEDED', 'REVIEW', 'mandate.approval_threshold', 'The cart total is at or above the approval threshold.'),
    );
  }

  // Split-purchase detection: several buys inside the window that each stay under a limit but together do not.
  // These go to a human (REVIEW) rather than DENY because legitimate repeat purchases look the same.
  const windowStart = nowMs - mandate.structuringWindowMinutes * 60_000;
  const recent = history.records.filter((record) => record.at.getTime() > windowStart);
  if (total < threshold && recent.length > 0) {
    const recentTotal = sum(recent.map((record) => BigInt(record.amountMinor)));
    if (recentTotal + total >= threshold) {
      reasons.push(
        reason(
          'STRUCTURING_SUSPECTED',
          'REVIEW',
          'structuring.approval_threshold',
          'Recent purchases plus this cart reach the approval threshold.',
        ),
      );
    }
  }
  cart.items.forEach((item, index) => {
    const lineTotal = lineTotals[index] ?? 0n;
    if (lineTotal > perItemCap) return;
    const before = sum(recent.filter((r) => r.productId === item.productId).map((r) => BigInt(r.amountMinor)));
    if (before > 0n && before + lineTotal > perItemCap) {
      reasons.push(
        reason(
          'STRUCTURING_SUSPECTED',
          'REVIEW',
          'structuring.per_item_cap',
          `Line ${index + 1}: recent purchases of the same product plus this line go past the per-item cap.`,
        ),
      );
    }
  });

  return reasons;
}

/**
 * Run immediately before capture: the approved amount is the paid amount (architecture failure mode 3).
 * Returns null when the re-quote is within tolerance. A lower price is always fine.
 */
export function checkPriceDrift(approved: Money, requoted: Money, toleranceBps: number): Reason | null {
  const a = parse(MoneySchema, approved, 'approved');
  const r = parse(MoneySchema, requoted, 'requoted');
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps > 10_000) {
    throw new PolicyInputError('Invalid toleranceBps');
  }
  if (a.currency !== r.currency) {
    return reason('CURRENCY_MISMATCH', 'BLOCK', 'drift.currency', `The re-quote is in ${r.currency} but was approved in ${a.currency}.`);
  }
  // Compare r / a > 1 + bps/10000 without division.
  if (BigInt(r.amountMinor) * 10_000n > BigInt(a.amountMinor) * BigInt(10_000 + toleranceBps)) {
    return reason('PRICE_DRIFT', 'BLOCK', 'drift.tolerance', 'The price rose past the tolerance since it was approved.');
  }
  return null;
}
