import type { AuditEntry, MandateView, PurchaseListItem, Summary } from './api';

/** The three parts of the budget, in minor units, and each one's share for the meter (0..1). */
export function budgetSegments(summary: Summary): { committed: number; held: number; remaining: number; shares: [number, number, number] } {
  const total = Math.max(summary.budgetMinor, summary.committedMinor + summary.heldMinor, 1);
  const remaining = Math.max(summary.remainingMinor, 0);
  return {
    committed: summary.committedMinor,
    held: summary.heldMinor,
    remaining,
    shares: [summary.committedMinor / total, summary.heldMinor / total, remaining / total],
  };
}

export interface CategoryRow {
  category: string;
  allowed: boolean;
  spentMinor: number;
  heldMinor: number;
  capMinor: number | null;
  /** Spent plus held as a share of the cap, or null when the category has no cap. */
  share: number | null;
}

/** Every category the mandate lists or that has spend, allowed ones first, then by spend. */
export function categoryRows(summary: Summary, mandate: MandateView): CategoryRow[] {
  const spend = new Map(summary.byCategory.map((line) => [line.category, line]));
  const names = new Set([...mandate.categoryLimits.map((limit) => limit.category), ...spend.keys()]);
  return [...names]
    .map((category) => {
      const limit = mandate.categoryLimits.find((l) => l.category === category);
      const line = spend.get(category);
      const spentMinor = line?.committedMinor ?? 0;
      const heldMinor = line?.heldMinor ?? 0;
      const capMinor = limit?.capMinor ?? null;
      return {
        category,
        allowed: limit?.allowed === true,
        spentMinor,
        heldMinor,
        capMinor,
        share: capMinor === null || capMinor === 0 ? null : (spentMinor + heldMinor) / capMinor,
      };
    })
    .sort((a, b) => Number(b.allowed) - Number(a.allowed) || b.spentMinor + b.heldMinor - (a.spentMinor + a.heldMinor) || a.category.localeCompare(b.category));
}

export type Filter = 'all' | 'blocked' | 'waiting' | 'paid';

const GROUPS: Record<Exclude<Filter, 'all'>, readonly string[]> = {
  blocked: ['DENIED', 'REJECTED', 'FAILED', 'EXPIRED'],
  waiting: ['PENDING_APPROVAL', 'NEEDS_CLARIFICATION'],
  paid: ['PAYMENT_PENDING', 'UNKNOWN_OUTCOME', 'CAPTURED'],
};

export function filterItems(items: readonly PurchaseListItem[], filter: Filter): PurchaseListItem[] {
  return filter === 'all' ? [...items] : items.filter((item) => GROUPS[filter].includes(item.status));
}

export function countBy(items: readonly PurchaseListItem[]): Record<Filter, number> {
  return {
    all: items.length,
    blocked: filterItems(items, 'blocked').length,
    waiting: filterItems(items, 'waiting').length,
    paid: filterItems(items, 'paid').length,
  };
}

/** "just now", "12 min", "3 h", "2 days": how long a request has been waiting. */
export function age(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

/** Audit actions in plain words. Unknown actions show as they are. */
const ACTIONS: Record<string, string> = {
  'request.received': 'Request received',
  'request.failed': 'Stopped',
  'proposal.rejected': "Agent's proposal refused",
  'policy.decided': 'Mandate decided',
  'approval.notified': 'Approver notified',
  'approval.notify_failed': 'Approver could not be notified',
  'approval.approved': 'Approved',
  'approval.rejected': 'Rejected',
  'approval.expired': 'Approval expired',
  'payment.order_created': 'PayPal order created',
  'payment.captured': 'Payment captured',
  'payment.failed': 'Payment failed',
  'payment.unknown_outcome': 'Payment outcome unknown',
  'payment.amount_mismatch': 'PayPal amount did not match',
  'payment.price_drift': 'Price changed before payment',
  'payment.voided': 'PayPal voided the order',
  'payment.expired': 'Payment window expired',
};

const ACTORS: Record<string, string> = { user: 'Person', agent: 'Agent', system: 'Mandate', webhook: 'PayPal' };

export function describeAudit(entry: AuditEntry): { what: string; who: string } {
  return { what: ACTIONS[entry.action] ?? entry.action, who: ACTORS[entry.actorType] ?? entry.actorType };
}
