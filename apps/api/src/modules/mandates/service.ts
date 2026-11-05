import type { Mandate } from '@mandate/policy';
import { toBigInt, type Db } from '../../db/db.js';
import { lockMandate } from '../purchases/policy-inputs.js';

export type MandateErrorCode = 'MANDATE_NOT_FOUND' | 'ACTOR_NOT_ALLOWED' | 'PURCHASE_NOT_FOUND';

export class MandateError extends Error {
  readonly code: MandateErrorCode;

  constructor(code: MandateErrorCode) {
    super(code);
    this.name = 'MandateError';
    this.code = code;
  }
}

export interface MandateView extends Omit<Mandate, 'startsAt' | 'endsAt'> {
  name: string;
  startsAt: string;
  endsAt: string;
  policyVersion: string;
  approver: { id: string; displayName: string };
}

/** Fields an admin may change. Absent fields keep their value; categoryLimits, when present, replaces the list. */
export interface MandateUpdate {
  budgetMinor?: number | undefined;
  perItemCapMinor?: number | undefined;
  approvalThresholdMinor?: number | undefined;
  maxQuantityPerLine?: number | undefined;
  status?: 'ACTIVE' | 'PAUSED' | 'CLOSED' | undefined;
  categoryLimits?: { category: string; allowed: boolean; capMinor?: number | undefined }[] | undefined;
}

export interface SpendLine {
  category: string;
  committedMinor: number;
  heldMinor: number;
}

export interface MandateSummary {
  mandateId: string;
  currency: string;
  budgetMinor: number;
  /** Captured spend. */
  committedMinor: number;
  /** Reserved for orders awaiting payment or approval. */
  heldMinor: number;
  remainingMinor: number;
  byCategory: SpendLine[];
  /** Purchase requests by status. */
  byStatus: Record<string, number>;
  pendingApprovals: number;
  /** Requests the guardrails stopped: policy DENY, or a proposal or request code refused. */
  blocked: number;
}

export interface PurchaseListItem {
  id: string;
  status: string;
  failureCode: string | null;
  createdAt: string;
  /** Requester-written text. Render as text, never as HTML. */
  text: string;
  requester: string;
  outcome: string | null;
  reasonCodes: string[];
  totalMinor: number | null;
  currency: string | null;
}

export interface AuditEntry {
  at: string;
  actorType: string;
  /** A user id for people; null for the agent and the system. */
  actorId: string | null;
  action: string;
  policyVersion: string | null;
}

const num = (value: unknown): number => Number(toBigInt(value ?? 0));

/** Read and admin views of a mandate, for the setup screen and the dashboard (#24, #25). */
export class MandateService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async get(mandateId: string): Promise<MandateView> {
    return this.#db.transaction(async (tx) => {
      const mandate = await lockMandate(tx, mandateId);
      if (!mandate) throw new MandateError('MANDATE_NOT_FOUND');
      const extra = await tx.query<{ name: string; policy_version: string; approver_id: string; approver_name: string }>(
        `SELECT m.name, m.policy_version, u.id AS approver_id, u.display_name AS approver_name
           FROM mandate m JOIN app_user u ON u.id = m.approver_user_id WHERE m.id = $1`,
        [mandateId],
      );
      const row = extra.rows[0] as NonNullable<(typeof extra.rows)[number]>;
      return {
        ...mandate,
        name: row.name,
        startsAt: mandate.startsAt.toISOString(),
        endsAt: mandate.endsAt.toISOString(),
        policyVersion: row.policy_version,
        approver: { id: row.approver_id, displayName: row.approver_name },
      };
    });
  }

  /**
   * Admin-only. The change and the previous values go to the audit log in the same transaction. A purchase
   * already being evaluated holds the mandate row lock, so it sees either the old or the new limits, never a mix.
   */
  async update(mandateId: string, actorUserId: string, change: MandateUpdate): Promise<MandateView> {
    await this.#db.transaction(async (tx) => {
      const before = await lockMandate(tx, mandateId);
      if (!before) throw new MandateError('MANDATE_NOT_FOUND');
      const actor = await tx.query<{ organization_id: string }>(
        `SELECT u.organization_id FROM app_user u JOIN mandate m ON m.organization_id = u.organization_id
          WHERE m.id = $1 AND u.id = $2 AND u.role = 'admin'`,
        [mandateId, actorUserId],
      );
      const organizationId = actor.rows[0]?.organization_id;
      if (!organizationId) throw new MandateError('ACTOR_NOT_ALLOWED');

      await tx.query(
        `UPDATE mandate SET
           budget_minor_units = COALESCE($2, budget_minor_units),
           per_item_cap_minor_units = COALESCE($3, per_item_cap_minor_units),
           approval_threshold_minor_units = COALESCE($4, approval_threshold_minor_units),
           max_quantity_per_line = COALESCE($5, max_quantity_per_line),
           status = COALESCE($6, status)
         WHERE id = $1`,
        [mandateId, change.budgetMinor ?? null, change.perItemCapMinor ?? null, change.approvalThresholdMinor ?? null, change.maxQuantityPerLine ?? null, change.status ?? null],
      );
      if (change.categoryLimits) {
        await tx.query('DELETE FROM category_limit WHERE mandate_id = $1', [mandateId]);
        for (const limit of change.categoryLimits) {
          await tx.query('INSERT INTO category_limit (mandate_id, category, allowed, cap_minor_units) VALUES ($1, $2, $3, $4)', [
            mandateId,
            limit.category,
            limit.allowed,
            limit.capMinor ?? null,
          ]);
        }
      }
      await tx.query(
        `INSERT INTO audit_log (organization_id, actor_type, actor_id, action, subject_type, subject_id, detail)
         VALUES ($1, 'user', $2, 'mandate.updated', 'mandate', $3, $4)`,
        [organizationId, actorUserId, mandateId, JSON.stringify({ change, before: { ...before, startsAt: undefined, endsAt: undefined } })],
      );
    });
    return this.get(mandateId);
  }

  async summary(mandateId: string): Promise<MandateSummary> {
    const db = this.#db;
    const mandate = await db.query<{ currency: string; budget_minor_units: unknown }>('SELECT currency, budget_minor_units FROM mandate WHERE id = $1', [mandateId]);
    const row = mandate.rows[0];
    if (!row) throw new MandateError('MANDATE_NOT_FOUND');

    const totals = await db.query<{ state: string; amount: unknown }>(
      `SELECT state, SUM(amount_minor_units) AS amount FROM budget_reservation
        WHERE mandate_id = $1 AND state IN ('HELD', 'COMMITTED') GROUP BY state`,
      [mandateId],
    );
    const committedMinor = num(totals.rows.find((t) => t.state === 'COMMITTED')?.amount);
    const heldMinor = num(totals.rows.find((t) => t.state === 'HELD')?.amount);

    const categories = await db.query<{ category: string; state: string; amount: unknown }>(
      `SELECT ps.category, br.state, SUM(ci.line_total_minor_units) AS amount
         FROM budget_reservation br
         JOIN policy_decision pd ON pd.id = br.policy_decision_id
         JOIN cart_item ci ON ci.cart_id = pd.cart_id
         JOIN product_snapshot ps ON ps.id = ci.product_snapshot_id
        WHERE br.mandate_id = $1 AND br.state IN ('HELD', 'COMMITTED')
        GROUP BY ps.category, br.state ORDER BY ps.category`,
      [mandateId],
    );
    const byCategory = new Map<string, SpendLine>();
    for (const line of categories.rows) {
      const entry = byCategory.get(line.category) ?? { category: line.category, committedMinor: 0, heldMinor: 0 };
      if (line.state === 'COMMITTED') entry.committedMinor += num(line.amount);
      else entry.heldMinor += num(line.amount);
      byCategory.set(line.category, entry);
    }

    const statuses = await db.query<{ status: string; count: unknown }>(
      'SELECT status, COUNT(*) AS count FROM purchase_request WHERE mandate_id = $1 GROUP BY status',
      [mandateId],
    );
    const byStatus = Object.fromEntries(statuses.rows.map((s) => [s.status, num(s.count)]));
    return {
      mandateId,
      currency: row.currency,
      budgetMinor: num(row.budget_minor_units),
      committedMinor,
      heldMinor,
      remainingMinor: num(row.budget_minor_units) - committedMinor - heldMinor,
      byCategory: [...byCategory.values()],
      byStatus,
      pendingApprovals: byStatus.PENDING_APPROVAL ?? 0,
      blocked: (byStatus.DENIED ?? 0) + (byStatus.REJECTED ?? 0) + (byStatus.FAILED ?? 0),
    };
  }

  /** Newest first. `status` filters to one status, e.g. PENDING_APPROVAL for the approvals queue. */
  async purchases(mandateId: string, options: { status?: string | undefined; limit?: number | undefined } = {}): Promise<PurchaseListItem[]> {
    const exists = await this.#db.query('SELECT 1 FROM mandate WHERE id = $1', [mandateId]);
    if (exists.rows.length === 0) throw new MandateError('MANDATE_NOT_FOUND');
    const { rows } = await this.#db.query<{
      id: string;
      status: string;
      failure_code: string | null;
      created_at: Date | string;
      raw_text: string;
      requester: string;
      outcome: string | null;
      reasons: { code: string }[] | string | null;
      total: unknown;
      currency: string | null;
    }>(
      `SELECT pr.id, pr.status, pr.failure_code, pr.created_at, pr.raw_text, u.display_name AS requester,
              pd.outcome, pd.reasons, c.total_minor_units AS total, c.currency
         FROM purchase_request pr
         JOIN app_user u ON u.id = pr.requester_user_id
         LEFT JOIN cart c ON c.purchase_request_id = pr.id
         LEFT JOIN LATERAL (
           SELECT outcome, reasons FROM policy_decision WHERE purchase_request_id = pr.id ORDER BY decided_at DESC LIMIT 1
         ) pd ON true
        WHERE pr.mandate_id = $1 AND ($2::text IS NULL OR pr.status = $2)
        ORDER BY pr.created_at DESC, pr.id
        LIMIT $3`,
      [mandateId, options.status ?? null, options.limit ?? 50],
    );
    return rows.map((r) => {
      const reasons = typeof r.reasons === 'string' ? (JSON.parse(r.reasons) as { code: string }[]) : (r.reasons ?? []);
      return {
        id: r.id,
        status: r.status,
        failureCode: r.failure_code,
        createdAt: new Date(r.created_at).toISOString(),
        text: r.raw_text,
        requester: r.requester,
        outcome: r.outcome,
        reasonCodes: reasons.map((reason) => reason.code),
        totalMinor: r.total === null ? null : num(r.total),
        currency: r.currency,
      };
    });
  }

  /**
   * The audit trail of one request, oldest first. Only who, what and when: the `detail` payloads stay
   * server-side, since some hold model output or retailer text.
   */
  async audit(purchaseId: string): Promise<AuditEntry[]> {
    const exists = await this.#db.query('SELECT 1 FROM purchase_request WHERE id = $1', [purchaseId]);
    if (exists.rows.length === 0) throw new MandateError('PURCHASE_NOT_FOUND');
    const { rows } = await this.#db.query<{ created_at: Date | string; actor_type: string; actor_id: string | null; action: string; policy_version: string | null }>(
      `SELECT created_at, actor_type, actor_id, action, policy_version FROM audit_log
        WHERE subject_type = 'purchase_request' AND subject_id = $1 ORDER BY created_at, id`,
      [purchaseId],
    );
    return rows.map((r) => ({ at: new Date(r.created_at).toISOString(), actorType: r.actor_type, actorId: r.actor_id, action: r.action, policyVersion: r.policy_version }));
  }
}

