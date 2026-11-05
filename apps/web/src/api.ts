import { MoneySchema } from '@mandate/shared';
import { z } from 'zod';

/**
 * Typed client for apps/api. Every response is validated before the UI reads it, so a changed or broken
 * API fails loudly here instead of rendering wrong numbers. Text fields that came from requesters or
 * retailers are plain strings: React renders them as text, never as HTML.
 */

const ReasonSchema = z.object({ code: z.string(), message: z.string(), ruleId: z.string(), severity: z.enum(['BLOCK', 'REVIEW', 'INFO']) });
export type Reason = z.infer<typeof ReasonSchema>;

export const PurchaseViewSchema = z.object({
  id: z.uuid(),
  mandateId: z.uuid(),
  status: z.string(),
  failureCode: z.string().optional(),
  clarifications: z.array(z.string()).optional(),
  cart: z
    .object({
      currency: z.string(),
      totalMinor: z.int(),
      items: z.array(z.object({ title: z.string(), category: z.string(), quantity: z.int(), unitPriceMinor: z.int(), lineTotalMinor: z.int() })),
    })
    .optional(),
  decision: z.object({ outcome: z.enum(['ALLOW', 'NEEDS_APPROVAL', 'DENY']), reasons: z.array(ReasonSchema), policyVersion: z.string(), evaluatedTotal: MoneySchema }).optional(),
  order: z.object({ id: z.string(), state: z.string(), providerStatus: z.string().optional(), approveUrl: z.url().optional() }).optional(),
});
export type PurchaseView = z.infer<typeof PurchaseViewSchema>;

const CategoryLimitSchema = z.object({ category: z.string(), allowed: z.boolean(), capMinor: z.int().optional() });
export type CategoryLimit = z.infer<typeof CategoryLimitSchema>;

export const MandateViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.string(),
  currency: z.string(),
  budgetMinor: z.int(),
  perItemCapMinor: z.int(),
  approvalThresholdMinor: z.int(),
  maxQuantityPerLine: z.int(),
  structuringWindowMinutes: z.int(),
  priceDriftToleranceBps: z.int(),
  startsAt: z.string(),
  endsAt: z.string(),
  policyVersion: z.string(),
  approver: z.object({ id: z.uuid(), displayName: z.string() }),
  categoryLimits: z.array(CategoryLimitSchema),
});
export type MandateView = z.infer<typeof MandateViewSchema>;

export const SummarySchema = z.object({
  mandateId: z.uuid(),
  currency: z.string(),
  budgetMinor: z.int(),
  committedMinor: z.int(),
  heldMinor: z.int(),
  remainingMinor: z.int(),
  byCategory: z.array(z.object({ category: z.string(), committedMinor: z.int(), heldMinor: z.int() })),
  byStatus: z.record(z.string(), z.int()),
  pendingApprovals: z.int(),
  blocked: z.int(),
});
export type Summary = z.infer<typeof SummarySchema>;

export const PurchaseListItemSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  failureCode: z.string().nullable(),
  createdAt: z.string(),
  text: z.string(),
  requester: z.string(),
  outcome: z.string().nullable(),
  reasonCodes: z.array(z.string()),
  totalMinor: z.int().nullable(),
  currency: z.string().nullable(),
});
export type PurchaseListItem = z.infer<typeof PurchaseListItemSchema>;

export const AuditEntrySchema = z.object({
  at: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  action: z.string(),
  policyVersion: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const ApprovalPreviewSchema = z.object({
  purchase: PurchaseViewSchema,
  approval: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']), expiresAt: z.string() }),
});
export type ApprovalPreview = z.infer<typeof ApprovalPreviewSchema>;

export interface MandateChange {
  budgetMinor?: number;
  perItemCapMinor?: number;
  approvalThresholdMinor?: number;
  maxQuantityPerLine?: number;
  status?: 'ACTIVE' | 'PAUSED' | 'CLOSED';
  categoryLimits?: CategoryLimit[];
}

/** An HTTP or validation failure. `code` is the API's error code when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`API request failed: ${status} ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class MandateApi {
  readonly #base: string;
  readonly #fetch: Fetch;

  constructor(baseUrl: string, fetchImpl: Fetch = (input, init) => fetch(input, init)) {
    this.#base = baseUrl.replace(/\/+$/, '');
    this.#fetch = fetchImpl;
  }

  async #call<T>(schema: z.ZodType<T>, path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
        signal: init.signal ?? AbortSignal.timeout(120_000),
      });
    } catch {
      throw new ApiError(0, 'NETWORK');
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = z.object({ error: z.string() }).safeParse(body);
      throw new ApiError(response.status, code.success ? code.data.error : 'HTTP_ERROR');
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError(response.status, 'UNEXPECTED_RESPONSE');
    return parsed.data;
  }

  submitPurchase(mandateId: string, input: { requesterUserId: string; text: string; requestKey: string }): Promise<PurchaseView> {
    return this.#call(PurchaseViewSchema, `/mandates/${mandateId}/purchases`, { method: 'POST', body: JSON.stringify(input) });
  }

  getPurchase(purchaseId: string): Promise<PurchaseView> {
    return this.#call(PurchaseViewSchema, `/purchases/${purchaseId}`);
  }

  capture(purchaseId: string): Promise<PurchaseView> {
    return this.#call(PurchaseViewSchema, `/purchases/${purchaseId}/capture`, { method: 'POST', body: '{}' });
  }

  getMandate(mandateId: string): Promise<MandateView> {
    return this.#call(MandateViewSchema, `/mandates/${mandateId}`);
  }

  updateMandate(mandateId: string, actorUserId: string, change: MandateChange): Promise<MandateView> {
    return this.#call(MandateViewSchema, `/mandates/${mandateId}`, { method: 'PATCH', body: JSON.stringify({ actorUserId, ...change }) });
  }

  getSummary(mandateId: string): Promise<Summary> {
    return this.#call(SummarySchema, `/mandates/${mandateId}/summary`);
  }

  /** What an approval link asks the approver to decide. The token goes in the body, never in a URL. */
  previewApproval(token: string): Promise<ApprovalPreview> {
    return this.#call(ApprovalPreviewSchema, '/approvals/preview', { method: 'POST', body: JSON.stringify({ token }) });
  }

  decideApproval(token: string, decision: 'APPROVE' | 'REJECT'): Promise<PurchaseView> {
    return this.#call(PurchaseViewSchema, '/approvals/decision', { method: 'POST', body: JSON.stringify({ token, decision, channel: 'zapier' }) });
  }

  async getAudit(purchaseId: string): Promise<AuditEntry[]> {
    const { entries } = await this.#call(z.object({ entries: z.array(AuditEntrySchema) }), `/purchases/${purchaseId}/audit`);
    return entries;
  }

  async listPurchases(mandateId: string, options: { status?: string; limit?: number } = {}): Promise<PurchaseListItem[]> {
    const query = new URLSearchParams();
    if (options.status) query.set('status', options.status);
    if (options.limit) query.set('limit', String(options.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const { items } = await this.#call(z.object({ items: z.array(PurchaseListItemSchema) }), `/mandates/${mandateId}/purchases${suffix}`);
    return items;
  }
}

/** A fresh idempotency key per submitted request (the API dedupes on it). */
export const newRequestKey = (): string => `web-${crypto.randomUUID()}`;
