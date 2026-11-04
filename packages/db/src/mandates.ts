import { CurrencySchema } from '@mandate/shared';
import { z } from 'zod';
import type { Queryable } from './pool.js';

// Mandate administration (finding M2, migration 0006). The runtime role cannot write mandate or category_limit rows
// directly; these wrappers call the SECURITY DEFINER functions, which check that `actorUserId` is an owner or admin of
// the mandate's organization (SQLSTATE MD010 otherwise) and audit every change in audit_log under that user.
//
// The database trusts the actor id it is given. The API must take it from the authenticated session, never from the
// request body: a caller that can choose the actor id can act as any admin of any organization.

const MinorUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Uuid = z.uuid();

export const MandateSettingsSchema = z
  .object({
    approverUserId: Uuid,
    name: z.string().min(1).max(200),
    currency: CurrencySchema,
    budgetMinor: MinorUnits,
    perItemCapMinor: MinorUnits,
    approvalThresholdMinor: MinorUnits,
    maxQuantityPerLine: z.number().int().min(1).max(10_000),
    structuringWindowMinutes: z.number().int().min(1).max(44_640),
    priceDriftToleranceBps: z.number().int().min(0).max(10_000),
    startsAt: z.date(),
    endsAt: z.date(),
    policyVersion: z.string().min(1),
  })
  .refine((s) => s.endsAt > s.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] });
export type MandateSettings = z.infer<typeof MandateSettingsSchema>;

export type MandateStatus = 'ACTIVE' | 'PAUSED' | 'CLOSED';

/** The parameters every admin function takes after the approver, name (and status) and currency. */
function settingsParams(s: MandateSettings): unknown[] {
  return [
    s.budgetMinor,
    s.perItemCapMinor,
    s.approvalThresholdMinor,
    s.maxQuantityPerLine,
    s.structuringWindowMinutes,
    s.priceDriftToleranceBps,
    s.startsAt,
    s.endsAt,
    s.policyVersion,
  ];
}

/** Creates an ACTIVE mandate. Throws MD010 if the actor is not an owner/admin of the organization, MD011 for an ineligible approver. */
export async function adminCreateMandate(client: Queryable, actorUserId: string, organizationId: string, settings: MandateSettings): Promise<string> {
  const s = MandateSettingsSchema.parse(settings);
  const { rows } = await client.query<{ id: string }>(
    'SELECT public.admin_create_mandate($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) AS id',
    [Uuid.parse(actorUserId), Uuid.parse(organizationId), s.approverUserId, s.name, s.currency, ...settingsParams(s)],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('admin_create_mandate returned no id');
  return id;
}

/** Replaces every administrable field of a mandate. Budget cuts below held or committed spend fail with MD001. */
export async function adminUpdateMandate(
  client: Queryable,
  actorUserId: string,
  mandateId: string,
  settings: MandateSettings & { status: MandateStatus },
): Promise<void> {
  const s = MandateSettingsSchema.parse(settings);
  const status = z.enum(['ACTIVE', 'PAUSED', 'CLOSED']).parse(settings.status);
  await client.query('SELECT public.admin_update_mandate($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)', [
    Uuid.parse(actorUserId),
    Uuid.parse(mandateId),
    s.approverUserId,
    s.name,
    status,
    s.currency,
    ...settingsParams(s),
  ]);
}

/** Adds or replaces the rule for one category. `capMinor` null means no cap. */
export async function adminSetCategoryLimit(
  client: Queryable,
  actorUserId: string,
  mandateId: string,
  limit: { category: string; allowed: boolean; capMinor: number | null },
): Promise<string> {
  const cap = limit.capMinor === null ? null : MinorUnits.parse(limit.capMinor);
  const { rows } = await client.query<{ id: string }>('SELECT public.admin_set_category_limit($1, $2, $3, $4, $5) AS id', [
    Uuid.parse(actorUserId),
    Uuid.parse(mandateId),
    limit.category,
    limit.allowed,
    cap,
  ]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('admin_set_category_limit returned no id');
  return id;
}

/** Removes the rule for one category. Returns false if there was none. */
export async function adminRemoveCategoryLimit(client: Queryable, actorUserId: string, mandateId: string, category: string): Promise<boolean> {
  const { rows } = await client.query<{ removed: boolean }>('SELECT public.admin_remove_category_limit($1, $2, $3) AS removed', [
    Uuid.parse(actorUserId),
    Uuid.parse(mandateId),
    category,
  ]);
  return rows[0]?.removed ?? false;
}

export type OrganizationRole = 'requester' | 'approver' | 'admin' | 'owner';

/**
 * Changes another user's role (migration 0007). The actor must be an owner or admin of that user's organization;
 * only an owner grants or removes admin and owner; nobody changes their own role (MD010). An organization keeps at
 * least one owner, and a mandate's approver cannot become a requester (MD011). Every change is audited.
 */
export async function adminSetUserRole(client: Queryable, actorUserId: string, targetUserId: string, role: OrganizationRole): Promise<void> {
  const parsed = z.enum(['requester', 'approver', 'admin', 'owner']).parse(role);
  await client.query('SELECT public.admin_set_user_role($1, $2, $3)', [Uuid.parse(actorUserId), Uuid.parse(targetUserId), parsed]);
}
