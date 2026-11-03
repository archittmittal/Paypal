import { CurrencySchema, MAX_ITEMS, MAX_QUANTITY } from '@mandate/shared';
import { z } from 'zod';

const MinorUnits = z.int().nonnegative();

/** Normalized category slug. Categories come from catalog data, so free text is never accepted here. */
export const CategorySchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

export const CategoryLimitSchema = z.strictObject({
  category: CategorySchema,
  /** `false` is an explicit block. A category with no limit row is not in the allow-list either. */
  allowed: z.boolean(),
  /** Ceiling on committed plus held spend in this category, including this cart. Absent = no category cap. */
  capMinor: MinorUnits.optional(),
});

export const MandateStatusSchema = z.enum(['ACTIVE', 'PAUSED', 'CLOSED']);

/** The rule set a team writes. Every money field is in minor units of `currency`. */
export const MandateSchema = z
  .strictObject({
    id: z.string().min(1).max(64),
    status: MandateStatusSchema,
    currency: CurrencySchema,
    budgetMinor: MinorUnits,
    /** Applies to each line total (unit price x quantity), not to the unit price. */
    perItemCapMinor: MinorUnits,
    /** At or above this cart total the outcome is at least NEEDS_APPROVAL. */
    approvalThresholdMinor: MinorUnits,
    /** Plausibility ceiling per line. Above it the cart is denied with a reason, not rejected as invalid. */
    maxQuantityPerLine: z.int().min(1).max(MAX_QUANTITY),
    /** Look-back window for split-purchase detection. */
    structuringWindowMinutes: z.int().min(1).max(60 * 24 * 31),
    /** Allowed price increase between decision and capture, in basis points (100 = 1%). */
    priceDriftToleranceBps: z.int().min(0).max(10_000),
    startsAt: z.date(),
    endsAt: z.date(),
    categoryLimits: z.array(CategoryLimitSchema).max(100),
  })
  .superRefine((mandate, ctx) => {
    if (mandate.endsAt.getTime() <= mandate.startsAt.getTime()) {
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'endsAt must be after startsAt' });
    }
    const seen = new Set<string>();
    mandate.categoryLimits.forEach((limit, index) => {
      if (seen.has(limit.category)) {
        ctx.addIssue({ code: 'custom', path: ['categoryLimits', index, 'category'], message: 'Duplicate category' });
      }
      seen.add(limit.category);
    });
  });

/**
 * A priced cart. Prices come from product snapshots, never from model output (ADR 0004).
 * Line totals and the cart total are computed by the engine, so callers cannot supply them.
 */
export const CartSchema = z.strictObject({
  currency: CurrencySchema,
  items: z
    .array(
      z.strictObject({
        productId: z.string().min(1).max(128),
        category: CategorySchema,
        unitPriceMinor: MinorUnits,
        quantity: z.int().min(1).max(MAX_QUANTITY),
      }),
    )
    .max(MAX_ITEMS),
  shippingMinor: MinorUnits,
  taxMinor: MinorUnits,
});

/**
 * One line of committed spend or held reservation against this mandate. Released reservations are left out
 * by the caller. Shipping and tax have no product or category.
 */
export const SpendRecordSchema = z.strictObject({
  at: z.date(),
  amountMinor: MinorUnits,
  currency: CurrencySchema,
  productId: z.string().min(1).max(128).optional(),
  category: CategorySchema.optional(),
});

export const HistorySchema = z.strictObject({
  records: z.array(SpendRecordSchema).max(10_000),
});

export type CategoryLimit = z.infer<typeof CategoryLimitSchema>;
export type Mandate = z.infer<typeof MandateSchema>;
export type MandateStatus = z.infer<typeof MandateStatusSchema>;
export type Cart = z.infer<typeof CartSchema>;
export type SpendRecord = z.infer<typeof SpendRecordSchema>;
export type History = z.infer<typeof HistorySchema>;
