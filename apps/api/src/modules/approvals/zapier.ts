import { z } from 'zod';
import type { ApprovalNotifier, ApprovalRequest } from '../purchases/ports.js';

export const ZAPIER_TIMEOUT_MS = 10_000;

const EnvSchema = z.object({
  // A Zapier "Catch Hook" URL. Anyone holding it can post to the Zap, so it is configuration, not code.
  ZAPIER_APPROVAL_WEBHOOK_URL: z.url({ protocol: /^https$/, hostname: /^hooks\.zapier\.com$/ }).optional(),
  // Where approvers open the review page: the web app's public URL.
  WEB_APP_URL: z
    .url({ protocol: /^https?$/ })
    .refine((url) => new URL(url).protocol === 'https:' || ['localhost', '127.0.0.1'].includes(new URL(url).hostname), 'http only for localhost')
    .optional(),
});

export interface ZapierConfig {
  webhookUrl: string;
  webAppUrl: string;
}

export class ZapierConfigError extends Error {
  readonly variables: string[];

  constructor(variables: string[]) {
    super(`Invalid Zapier configuration: ${variables.join(', ')}`);
    this.name = 'ZapierConfigError';
    this.variables = variables;
  }
}

/** Undefined when the Zap is not configured (approvals then wait for the expiry sweep). Names variables only on error. */
export function loadZapierConfig(env: Readonly<Record<string, string | undefined>>): ZapierConfig | undefined {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) throw new ZapierConfigError([...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))]);
  const { ZAPIER_APPROVAL_WEBHOOK_URL: webhookUrl, WEB_APP_URL: webAppUrl } = parsed.data;
  if (!webhookUrl && !webAppUrl) return undefined;
  if (!webhookUrl || !webAppUrl) throw new ZapierConfigError([webhookUrl ? 'WEB_APP_URL' : 'ZAPIER_APPROVAL_WEBHOOK_URL']);
  return { webhookUrl, webAppUrl };
}

/** What the Zap receives. Plain JSON fields so a Zap can map them into an email or a Slack message. */
export interface ApprovalPayload {
  event: 'approval.requested';
  approvalId: string;
  purchaseId: string;
  amountMinor: number;
  currency: string;
  /** e.g. "$323.99" */
  amountDisplay: string;
  expiresAt: string;
  reasons: { code: string; message: string }[];
  /**
   * The approver's link. The single-use token sits in the URL fragment, which browsers never send to a server,
   * so it stays out of access logs and Referer headers. Zapier does see it: tokens are single-use, expire, and
   * are stored only as a SHA-256 hash, so the link is the whole credential and nothing else is.
   */
  reviewUrl: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function approvalPayload(request: ApprovalRequest, webAppUrl: string): ApprovalPayload {
  const amountDisplay = new Intl.NumberFormat('en-US', { style: 'currency', currency: request.amount.currency }).format(
    `${request.amount.amountMinor}E-${new Intl.NumberFormat('en', { style: 'currency', currency: request.amount.currency }).resolvedOptions().maximumFractionDigits ?? 2}` as `${number}`,
  );
  return {
    event: 'approval.requested',
    approvalId: request.approvalId,
    purchaseId: request.purchaseId,
    amountMinor: request.amount.amountMinor,
    currency: request.amount.currency,
    amountDisplay,
    expiresAt: request.expiresAt.toISOString(),
    reasons: request.reasons.map((reason) => ({ code: reason.code, message: reason.message })),
    reviewUrl: `${webAppUrl.replace(/\/+$/, '')}/#/approve/${request.token}`,
  };
}

/**
 * Sends approval requests to a Zapier Catch Hook (#26). A non-2xx answer or a timeout throws, and the purchase
 * flow records `approval.notify_failed`; the request stays pending and its hold is released at expiry.
 */
export class ZapierApprovalNotifier implements ApprovalNotifier {
  readonly #config: ZapierConfig;
  readonly #fetch: FetchLike;

  constructor(config: ZapierConfig, fetchImpl: FetchLike = (url, init) => fetch(url, init)) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  async notify(request: ApprovalRequest): Promise<void> {
    const response = await this.#fetch(this.#config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(approvalPayload(request, this.#config.webAppUrl)),
      signal: AbortSignal.timeout(ZAPIER_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Zapier webhook answered ${response.status}`);
  }
}
