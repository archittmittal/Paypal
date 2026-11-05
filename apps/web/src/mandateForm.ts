import type { MandateChange, MandateView } from './api';
import { minorToDecimal, parseMoneyInput } from './money';

/** The editable mandate as text fields, so a half-typed amount is never coerced into a number. */
export interface MandateForm {
  status: 'ACTIVE' | 'PAUSED' | 'CLOSED';
  budget: string;
  perItemCap: string;
  approvalThreshold: string;
  maxQuantityPerLine: string;
  categories: { category: string; allowed: boolean; cap: string }[];
}

export type FieldErrors = Partial<Record<'budget' | 'perItemCap' | 'approvalThreshold' | 'maxQuantityPerLine', string>> & {
  categories?: Record<number, string>;
};

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STATUSES = ['ACTIVE', 'PAUSED', 'CLOSED'] as const;

export function toForm(mandate: MandateView): MandateForm {
  const money = (minor: number) => minorToDecimal(minor, mandate.currency);
  return {
    status: (STATUSES as readonly string[]).includes(mandate.status) ? (mandate.status as MandateForm['status']) : 'ACTIVE',
    budget: money(mandate.budgetMinor),
    perItemCap: money(mandate.perItemCapMinor),
    approvalThreshold: money(mandate.approvalThresholdMinor),
    maxQuantityPerLine: String(mandate.maxQuantityPerLine),
    categories: mandate.categoryLimits.map((limit) => ({
      category: limit.category,
      allowed: limit.allowed,
      cap: limit.capMinor === undefined ? '' : money(limit.capMinor),
    })),
  };
}

/** Category names as people type them ("Office Supplies") become policy slugs ("office-supplies"). */
export function toSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Validates the whole form and builds the PATCH body. Category limits are always sent in full: the API
 * replaces the list. Amounts must be exact in the mandate's currency; nothing is rounded.
 */
export function fromForm(form: MandateForm, currency: string): { ok: true; change: MandateChange } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const money = (field: 'budget' | 'perItemCap' | 'approvalThreshold') => {
    const minor = parseMoneyInput(form[field], currency);
    if (minor === null) errors[field] = `Enter an amount like 250 or 250.00 in ${currency}.`;
    return minor ?? 0;
  };
  const budgetMinor = money('budget');
  const perItemCapMinor = money('perItemCap');
  const approvalThresholdMinor = money('approvalThreshold');
  const maxQuantityPerLine = /^\d{1,5}$/.test(form.maxQuantityPerLine.trim()) ? Number(form.maxQuantityPerLine.trim()) : NaN;
  if (!(maxQuantityPerLine >= 1 && maxQuantityPerLine <= 10_000)) errors.maxQuantityPerLine = 'Enter a whole number from 1 to 10000.';

  const categoryErrors: Record<number, string> = {};
  const seen = new Set<string>();
  const categoryLimits = form.categories.map((row, index) => {
    const category = toSlug(row.category);
    if (!SLUG.test(category)) categoryErrors[index] = 'Name the category with letters or numbers.';
    else if (seen.has(category)) categoryErrors[index] = 'This category is listed twice.';
    seen.add(category);
    if (row.cap.trim() === '') return { category, allowed: row.allowed };
    const capMinor = parseMoneyInput(row.cap, currency);
    if (capMinor === null) categoryErrors[index] = `Enter a cap like 500.00 in ${currency}, or leave it empty for no cap.`;
    return { category, allowed: row.allowed, capMinor: capMinor ?? 0 };
  });
  if (Object.keys(categoryErrors).length > 0) errors.categories = categoryErrors;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, change: { status: form.status, budgetMinor, perItemCapMinor, approvalThresholdMinor, maxQuantityPerLine, categoryLimits } };
}
