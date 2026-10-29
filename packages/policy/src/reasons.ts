/**
 * Reason codes are stable identifiers: the dashboard, the audit log and the eval harness all key on them.
 * Rename one only together with a POLICY_VERSION bump.
 */
export type ReasonCode =
  | 'MANDATE_INACTIVE'
  | 'EMPTY_CART'
  | 'CURRENCY_MISMATCH'
  | 'CATEGORY_NOT_ALLOWED'
  | 'CATEGORY_CAP_EXCEEDED'
  | 'PER_ITEM_CAP_EXCEEDED'
  | 'QUANTITY_IMPLAUSIBLE'
  | 'BUDGET_EXHAUSTED'
  | 'THRESHOLD_EXCEEDED'
  | 'STRUCTURING_SUSPECTED'
  | 'PRICE_DRIFT'
  | 'WITHIN_MANDATE';

/** BLOCK forces DENY, REVIEW forces at least NEEDS_APPROVAL, INFO changes nothing. */
export type Severity = 'BLOCK' | 'REVIEW' | 'INFO';

/**
 * `message` is for people and is built only from fixed text, line numbers and category slugs.
 * Product titles and other retailer text never appear in it.
 */
export interface Reason {
  code: ReasonCode;
  message: string;
  ruleId: string;
  severity: Severity;
}

export function reason(code: ReasonCode, severity: Severity, ruleId: string, message: string): Reason {
  return { code, message, ruleId, severity };
}
