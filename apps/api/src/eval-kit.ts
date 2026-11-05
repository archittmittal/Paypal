/**
 * The surface packages/evals (#19) uses to run the real purchase flow in-process for configuration (c).
 * The server never imports this file. Re-exports only: no behaviour lives here.
 */
export { PurchaseService, type PurchaseView } from './modules/purchases/service.js';
export type { Catalog, CatalogProduct, GatewayOrder, PaymentGateway } from './modules/purchases/ports.js';
export { FIXTURE_PRODUCTS, FixtureCatalog } from './modules/catalog/fixture.js';
export { categorySlug, normalizeProducts, type RawProduct } from './modules/catalog/normalize.js';
export { loadMigrations, migrate } from './db/migrate.js';
export { DEMO_IDS, seed } from './db/seed.js';
export type { Db, Queryable } from './db/db.js';
