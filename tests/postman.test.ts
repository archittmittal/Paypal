import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Postman collection must stay in step with the API and must never carry a secret (hard rule 7).

interface Item {
  name: string;
  item?: Item[];
  request?: { method: string; url: { path: string[] }; header: { key: string }[]; body?: { raw: string } };
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const collection = JSON.parse(readFileSync(join(ROOT, 'postman/mandate.postman_collection.json'), 'utf8')) as { info: { schema: string }; item: Item[]; variable: { key: string; value: string }[] };

const requests = (items: Item[]): NonNullable<Item['request']>[] => items.flatMap((item) => (item.item ? requests(item.item) : item.request ? [item.request] : []));

/** Every `app.<method>('/path'` registered under apps/api/src, as METHOD /path with :params. */
function apiRoutes(): Set<string> {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []));
  const routes = new Set<string>();
  for (const file of files(join(ROOT, 'apps/api/src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/app\.(get|post|patch|put|delete)\('([^']+)'/g)) routes.add(`${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`);
  }
  return routes;
}

describe('postman collection', () => {
  it('is a v2.1 collection', () => {
    expect(collection.info.schema).toBe('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
  });

  it('only calls routes the API registers', () => {
    const routes = apiRoutes();
    expect(routes.size).toBeGreaterThan(5);
    const used = requests(collection.item).map((r) => {
      const path = r.url.path.map((segment) => (segment.startsWith('{{') ? ':param' : segment.split('?')[0])).join('/');
      return `${r.method} /${path}`;
    });
    const normalized = new Set([...routes].map((route) => route.replace(/:[A-Za-z]+/g, ':param')));
    expect(used.filter((route) => !normalized.has(route))).toEqual([]);
  });

  it('covers every API route except the PayPal webhook, which needs PayPal to sign it', () => {
    const used = new Set(requests(collection.item).map((r) => `${r.method} /${r.url.path.map((s) => (s.startsWith('{{') ? ':param' : s.split('?')[0])).join('/')}`));
    const missing = [...apiRoutes()].map((route) => route.replace(/:[A-Za-z]+/g, ':param')).filter((route) => !used.has(route));
    expect(missing).toEqual(['POST /webhooks/paypal']);
  });

  it('holds no credentials', () => {
    const text = JSON.stringify(collection);
    expect(requests(collection.item).flatMap((r) => r.header.map((h) => h.key.toLowerCase()))).not.toContain('authorization');
    expect(text).not.toMatch(/sk-ant-|client_secret|Bearer |password/i);
    expect(collection.variable.map((v) => v.key)).toEqual(['baseUrl', 'mandateId', 'requesterId', 'adminId', 'purchaseId', 'approvalToken']);
  });
});
