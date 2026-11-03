export type PaymentErrorCode =
  | 'PAYPAL_AUTH'
  | 'PAYPAL_BAD_REQUEST'
  | 'PAYPAL_NOT_FOUND'
  | 'PAYPAL_UNPROCESSABLE'
  | 'PAYPAL_RATE_LIMITED'
  | 'PAYPAL_UNAVAILABLE'
  | 'PAYPAL_BAD_RESPONSE'
  | 'AMOUNT_MISMATCH'
  | 'UNKNOWN_OUTCOME';

// Fixed, safe messages: never request bodies, tokens or PayPal payloads.
const MESSAGES: Record<PaymentErrorCode, string> = {
  PAYPAL_AUTH: 'PayPal rejected the credentials',
  PAYPAL_BAD_REQUEST: 'PayPal rejected the request',
  PAYPAL_NOT_FOUND: 'PayPal resource not found',
  PAYPAL_UNPROCESSABLE: 'PayPal could not process the request',
  PAYPAL_RATE_LIMITED: 'PayPal rate limit reached',
  PAYPAL_UNAVAILABLE: 'PayPal unavailable',
  PAYPAL_BAD_RESPONSE: 'PayPal response failed schema validation',
  AMOUNT_MISMATCH: 'Captured amount differs from the expected amount',
  UNKNOWN_OUTCOME: 'Money-moving call outcome unknown; reconcile with getOrder before retrying',
};

export interface PaymentErrorDetails {
  status?: number;
  /** PayPal's debug_id, safe to log and quote to PayPal support. */
  debugId?: string;
  /** PayPal's issue codes, e.g. INSTRUMENT_DECLINED. Codes only, never descriptions. */
  issues?: readonly string[];
}

/** The only error PaypalClient raises. */
export class PaymentError extends Error {
  readonly code: PaymentErrorCode;
  readonly details: PaymentErrorDetails;

  constructor(code: PaymentErrorCode, details: PaymentErrorDetails = {}) {
    super(MESSAGES[code]);
    this.name = 'PaymentError';
    this.code = code;
    this.details = details;
  }
}

export function codeForStatus(status: number): PaymentErrorCode {
  if (status === 401 || status === 403) return 'PAYPAL_AUTH';
  if (status === 404) return 'PAYPAL_NOT_FOUND';
  if (status === 422) return 'PAYPAL_UNPROCESSABLE';
  if (status === 429) return 'PAYPAL_RATE_LIMITED';
  if (status >= 500) return 'PAYPAL_UNAVAILABLE';
  return 'PAYPAL_BAD_REQUEST';
}
