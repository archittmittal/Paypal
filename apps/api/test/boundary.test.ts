import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Hard rule 1: only the payments module talks to PayPal. Inside the API that means only files under
// src/modules/payments/ may import @mandate/payments or any PayPal SDK.

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const PAYMENTS_DIR = 'modules/payments/';
const FORBIDDEN = [/^@mandate\/payments(\/|$)/, /(^|\/)packages\/payments(\/|$)/, /paypal/i];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

export function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? '');
}

export function violations(files: { path: string; source: string }[]): string[] {
  return files.flatMap(({ path, source }) =>
    path.startsWith(PAYMENTS_DIR)
      ? []
      : specifiers(source)
          .filter((spec) => FORBIDDEN.some((pattern) => pattern.test(spec)))
          .map((spec) => `${path} imports ${spec}`),
  );
}

function readSources(dir: string): { path: string; source: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return readSources(full);
    if (!entry.name.endsWith('.ts')) return [];
    return [{ path: relative(SRC, full).split(sep).join('/'), source: readFileSync(full, 'utf8') }];
  });
}

describe('payments import boundary', () => {
  it.each([
    ['a static import', "import { PaypalClient } from '@mandate/payments';"],
    ['a type-only import', "import type { OrderSummary } from '@mandate/payments';"],
    ['a dynamic import', "const p = await import('@mandate/payments');"],
    ['a re-export', "export * from '@mandate/payments';"],
    ['a PayPal SDK', "import { Client } from '@paypal/paypal-server-sdk';"],
    ['a relative path into the package', "import { x } from '../../../packages/payments/src/client.js';"],
  ])('flags %s outside the payments module', (_label, source) => {
    expect(violations([{ path: 'modules/intake/routes.ts', source }])).toHaveLength(1);
  });

  it('allows the payments module itself', () => {
    const source = "import { PaypalClient } from '@mandate/payments';";
    expect(violations([{ path: 'modules/payments/service.ts', source }])).toEqual([]);
  });

  it('does not let a look-alike directory through', () => {
    const source = "import { PaypalClient } from '@mandate/payments';";
    expect(violations([{ path: 'modules/payments-helpers/x.ts', source }])).toHaveLength(1);
  });

  it('holds for every file in apps/api/src', () => {
    const files = readSources(SRC);
    expect(files.length).toBeGreaterThan(0);
    expect(violations(files)).toEqual([]);
  });
});
