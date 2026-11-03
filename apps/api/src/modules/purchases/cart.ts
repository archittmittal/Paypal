import { ProposalSchema } from '@mandate/shared';

export interface SnapshotRef {
  snapshotId: string;
  productId: string;
  category: string;
  unitPriceMinor: number;
  currency: string;
}

export interface CartLine extends SnapshotRef {
  quantity: number;
  lineTotalMinor: number;
}

export type BuildCartResult =
  | { ok: true; currency: string; lines: CartLine[]; subtotalMinor: number }
  | { ok: false; reason: 'NO_SELECTION' | 'UNKNOWN_CANDIDATE' | 'MIXED_CURRENCY' | 'INVALID_PROPOSAL' | 'OVERFLOW' };

/**
 * Turns a ranker proposal into priced cart lines (hard rule 2). The proposal is re-validated here even though
 * the ranker validated it: it is model output. Prices come only from the snapshots; any price, total or
 * other number the model wrote is ignored because only candidateId and quantity are read.
 */
export function buildCart(proposal: unknown, snapshots: ReadonlyMap<string, SnapshotRef>): BuildCartResult {
  const parsed = ProposalSchema.safeParse(proposal);
  if (!parsed.success) return { ok: false, reason: 'INVALID_PROPOSAL' };
  const { selections } = parsed.data;
  if (selections.length === 0) return { ok: false, reason: 'NO_SELECTION' };

  const lines: CartLine[] = [];
  for (const selection of selections) {
    const snapshot = snapshots.get(selection.candidateId);
    // A fabricated id is an injection signal: reject the whole proposal rather than drop the line.
    if (!snapshot) return { ok: false, reason: 'UNKNOWN_CANDIDATE' };
    lines.push({ ...snapshot, quantity: selection.quantity, lineTotalMinor: 0 });
  }

  const currency = lines[0]?.currency ?? '';
  // Mixed-currency carts are rejected at intake, not converted (docs/er-diagram.md, Money).
  if (lines.some((line) => line.currency !== currency)) return { ok: false, reason: 'MIXED_CURRENCY' };

  let subtotal = 0n;
  for (const line of lines) {
    const lineTotal = BigInt(line.unitPriceMinor) * BigInt(line.quantity);
    subtotal += lineTotal;
    if (subtotal > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'OVERFLOW' };
    line.lineTotalMinor = Number(lineTotal);
  }
  return { ok: true, currency, lines, subtotalMinor: Number(subtotal) };
}
