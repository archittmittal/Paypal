import type { RawProduct } from '@mandate/api/eval-kit';
import type { FakeScript, Scenario, ScriptedToolCall } from '../scenario.js';
import { EVAL_CATALOG, productById } from './catalog.js';

/**
 * Scripted replies for a model that does exactly what the requester literally asked: it never follows an
 * injection. Fake mode with these scripts checks the labels and the harness; it says nothing about how a
 * real model behaves.
 */
export function idealFake(scenario: Scenario): FakeScript {
  const catalog: readonly RawProduct[] = scenario.catalog ?? EVAL_CATALOG;
  const ideal = scenario.ideal ?? [];
  const mandate: string[] = [];
  const naive: ScriptedToolCall[][] = [];
  const seenKeys = new Set<string>();

  scenario.steps.forEach((step, index) => {
    const cart = ideal[index] ?? [];
    const products = cart.map((line) => ({ ...line, product: productById(catalog, line.productId) }));
    const items = products.map((line) => ({ productId: line.productId, quantity: line.quantity }));
    const totalMinor = products.reduce((sum, line) => sum + (line.product.unitPriceMinor as number) * line.quantity, 0);
    naive.push([
      scenario.expect === 'pay'
        ? { name: 'pay', input: { items, totalMinor, currency: 'USD' } }
        : scenario.expect === 'approval'
          ? { name: 'request_approval', input: { items, totalMinor, reason: 'over the approval threshold' } }
          : { name: 'decline', input: { reason: 'not allowed by the mandate' } },
    ]);

    // A replayed request key never reaches the model under Mandate, so it gets no replies.
    if (step.requestKey !== undefined && seenKeys.has(step.requestKey)) return;
    if (step.requestKey !== undefined) seenKeys.add(step.requestKey);
    mandate.push(
      JSON.stringify({
        schemaVersion: '1',
        items: products.map((line) => ({ description: String(line.product.title), quantity: line.quantity })),
        clarifications: [],
        needsClarification: false,
      }),
      JSON.stringify({
        selections: products.map((line) => ({ candidateId: `{{cand:${String(line.product.title)}}}`, quantity: line.quantity, reason: 'requested' })),
        unmatchedItems: [],
      }),
    );
  });
  return { naive, hardened: naive, mandate };
}

/** Attaches ideal fake scripts to scenarios that declare an ideal cart and have no script of their own. */
export function withIdealFakes(scenarios: readonly Scenario[]): Scenario[] {
  return scenarios.map((scenario) => (scenario.fake || !scenario.ideal ? scenario : { ...scenario, fake: idealFake(scenario) }));
}
