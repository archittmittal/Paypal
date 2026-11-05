import { describe, expect, it } from 'vitest';
import { fakeModels, runSuite } from '../src/runner.js';
import { DEV_ATTACKS, HELDOUT_ATTACKS } from '../src/scenarios/attacks.js';
import { BENIGN_SCENARIOS } from '../src/scenarios/benign.js';
import { EVAL_CATALOG, productById } from '../src/scenarios/catalog.js';
import { idealFake } from '../src/scenarios/ideal.js';
import { ALL_SCENARIOS } from '../src/scenarios/index.js';

describe('suite integrity', () => {
  it('has ~30 benign cases and 25+ attacks, split dev / held-out', () => {
    expect(BENIGN_SCENARIOS.length).toBeGreaterThanOrEqual(30);
    expect(DEV_ATTACKS.length + HELDOUT_ATTACKS.length).toBeGreaterThanOrEqual(25);
    expect(DEV_ATTACKS.every((s) => s.set === 'attack-dev')).toBe(true);
    expect(HELDOUT_ATTACKS.every((s) => s.set === 'attack-heldout')).toBe(true);
    expect(BENIGN_SCENARIOS.every((s) => s.set === 'benign')).toBe(true);
  });

  it('covers every attack category in both halves', () => {
    const dev = new Set(DEV_ATTACKS.map((s) => s.category));
    const heldout = new Set(HELDOUT_ATTACKS.map((s) => s.category));
    expect([...dev].sort()).toEqual([...heldout].sort());
    expect(dev.size).toBeGreaterThanOrEqual(10);
  });

  it('has unique ids, forbidden rules on every attack, and a faithful cart per step from the scenario catalog', () => {
    const ids = ALL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of ALL_SCENARIOS) {
      if (scenario.set !== 'benign') expect(scenario.forbidden?.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.ideal?.length, scenario.id).toBe(scenario.steps.length);
      for (const line of (scenario.ideal ?? []).flat()) expect(() => productById(scenario.catalog ?? EVAL_CATALOG, line.productId)).not.toThrow();
      expect(scenario.fake, scenario.id).toBeDefined();
    }
  });

  it('derives one baseline turn per step and Mandate replies only for steps that reach the model', () => {
    for (const scenario of ALL_SCENARIOS) {
      const fake = idealFake(scenario);
      expect(fake.naive, scenario.id).toHaveLength(scenario.steps.length);
      const keys = scenario.steps.map((step) => step.requestKey);
      const fresh = keys.filter((key, index) => key === undefined || keys.indexOf(key) === index).length;
      expect(fake.mandate, scenario.id).toHaveLength(fresh * 2);
    }
  });

  it('productById rejects an unknown product', () => {
    expect(() => productById(EVAL_CATALOG, 'nope')).toThrow('Unknown product');
  });
});

describe('labels agree with the real policy engine', () => {
  it('under Mandate, the faithful cart of every scenario ends exactly as `expect` says, with no attack success', async () => {
    const run = await runSuite(ALL_SCENARIOS, ['mandate'], fakeModels);
    const wrong = run.cases
      .filter((c) => !c.taskSuccess || c.attackSucceeded || c.falseBlock || c.errors.length > 0)
      .map((c) => `${c.scenarioId}: ${c.outcome} via ${c.steps.join(' > ')}`);
    expect(wrong).toEqual([]);
    expect(run.cases).toHaveLength(ALL_SCENARIOS.length);
  }, 600_000);
});
