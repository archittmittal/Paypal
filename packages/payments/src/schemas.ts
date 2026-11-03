import { z } from 'zod';

// PayPal returns many more fields than these. z.object strips the rest, so only what we read is typed.

export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
});

const AmountSchema = z.object({ currency_code: z.string(), value: z.string() });

export const OrderStatusSchema = z.enum([
  'CREATED',
  'SAVED',
  'APPROVED',
  'VOIDED',
  'COMPLETED',
  'PAYER_ACTION_REQUIRED',
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderResponseSchema = z.object({
  id: z.string().regex(/^[A-Z0-9]{1,64}$/),
  status: OrderStatusSchema,
  links: z.array(z.object({ href: z.url(), rel: z.string() })).default([]),
  payment_source: z
    .object({
      paypal: z
        .object({
          attributes: z
            .object({
              vault: z
                .object({
                  id: z.string().optional(),
                  status: z.string(),
                  customer: z.object({ id: z.string() }).optional(),
                })
                .optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
  purchase_units: z
    .array(
      z.object({
        custom_id: z.string().optional(),
        payments: z
          .object({
            captures: z.array(z.object({ id: z.string(), status: z.string(), amount: AmountSchema })).default([]),
          })
          .optional(),
      }),
    )
    .default([]),
});
export type OrderResponse = z.infer<typeof OrderResponseSchema>;

export const ErrorBodySchema = z.object({
  debug_id: z.string().optional(),
  details: z.array(z.object({ issue: z.string() })).optional(),
});
