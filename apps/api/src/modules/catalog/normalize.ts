import { randomBytes } from 'node:crypto';
import { CandidateSchema } from '@mandate/shared';
import type { CatalogProduct } from '../purchases/ports.js';

/**
 * Provider-neutral product as a catalog adapter hands it over, before validation. The Channel3 adapter
 * maps its response into this shape once its API is verified (#16); the fixture catalog uses it directly.
 * Prices must already be integer minor units: an adapter that receives decimals converts them exactly.
 */
export interface RawProduct {
  sourceProductId: unknown;
  retailer: unknown;
  title: unknown;
  description?: unknown;
  /** Integer minor units. */
  unitPriceMinor: unknown;
  currency: unknown;
  url: unknown;
  /** Free-text category from the provider; normalized to a policy slug here. */
  category?: unknown;
}

export const UNCATEGORIZED = 'uncategorized';

/** Free-text provider category -> slug matching @mandate/policy (`^[a-z0-9][a-z0-9_-]{0,63}$`). */
export function categorySlug(raw: unknown): string {
  if (typeof raw !== 'string') return UNCATEGORIZED;
  const slug = raw
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug === '' ? UNCATEGORIZED : slug;
}

/** Opaque candidate id: the model sees this, never a database id or the provider's product id. */
export const randomCandidateId = (): string => `cand_${randomBytes(8).toString('hex')}`;

export interface NormalizeOptions {
  provider: string;
  fetchedAt: Date;
  newId?: () => string;
}

export interface NormalizeResult {
  products: CatalogProduct[];
  /** Products dropped because they failed CandidateSchema (docs/llm-layer.md section 13, item 11). */
  dropped: number;
}

/**
 * Validates and quarantines provider products. Anything that fails the schema (a float price, an http or
 * credentialed URL, a title that is empty after quarantine) is dropped and counted, never repaired.
 */
export function normalizeProducts(raw: readonly RawProduct[], options: NormalizeOptions): NormalizeResult {
  const newId = options.newId ?? randomCandidateId;
  const fetchedAt = options.fetchedAt.toISOString();
  const products: CatalogProduct[] = [];
  let dropped = 0;
  for (const product of raw) {
    const parsed = CandidateSchema.safeParse({
      id: newId(),
      sourceProductId: product.sourceProductId,
      retailer: product.retailer,
      unitPrice: { amountMinor: product.unitPriceMinor, currency: product.currency },
      url: product.url,
      fetchedAt,
      title: product.title,
      description: product.description ?? '',
    });
    if (!parsed.success) {
      dropped++;
      continue;
    }
    products.push({ candidate: parsed.data, category: categorySlug(product.category), provider: options.provider, raw: product });
  }
  return { products, dropped };
}
