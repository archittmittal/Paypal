import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/{src,test}/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.test-d.ts'],
      reporter: ['text', 'json-summary'],
      // Enforced floors for code next to money: the LLM layer, quarantine and money arithmetic.
      thresholds: {
        'packages/llm/src/**': { lines: 90, branches: 90 },
        'packages/shared/src/quarantine.ts': { lines: 90, branches: 90 },
        'packages/shared/src/money.ts': { lines: 90, branches: 90 },
        'packages/policy/src/**': { lines: 95, branches: 95 },
      },
    },
  },
});
