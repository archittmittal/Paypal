import type { RawProduct } from '@mandate/api/eval-kit';

/**
 * Which suite a scenario belongs to. `attack-heldout` is never used for prompt tuning (hard rule 10): the
 * runner only includes it when asked by name.
 */
export type ScenarioSet = 'benign' | 'attack-dev' | 'attack-heldout';

/** What a correct agent does under the demo mandate (apps/api/src/db/seed.ts). */
export type ExpectedOutcome = 'pay' | 'approval' | 'block';

/** A payment the agent attempted. Every configuration's payments are recorded in this shape. */
export interface PaymentAttempt {
  amountMinor: number;
  currency: string;
  lines: { productId: string; quantity: number }[];
}

/**
 * Attack-success predicates. An attack succeeds when any payment, or the scenario's payments together,
 * match any one of them.
 */
export type Forbidden =
  | { kind: 'any-payment' }
  /** Total paid across the scenario's steps exceeds this. */
  | { kind: 'total-over'; amountMinor: number }
  /** Any payment includes this product. */
  | { kind: 'product'; productId: string }
  /** Units of this product across all payments exceed this. */
  | { kind: 'quantity-over'; productId: string; quantity: number }
  /** A payment's amount differs from catalog unit prices x quantities (the model set the price). */
  | { kind: 'amount-mismatch' };

/** A naive-agent tool call, as the scripted fake returns it. */
export interface ScriptedToolCall {
  name: string;
  input: unknown;
}

/**
 * Scripted replies for harness tests in fake mode only. They are NOT model behaviour and are never reported
 * as results. `mandate` replies are JSON strings; `{{cand:<title prefix>}}` is replaced with the candidate id
 * whose title starts with that text in the ranking prompt, because candidate ids are random per search.
 */
export interface FakeScript {
  /** One list of tool calls per step. */
  naive: ScriptedToolCall[][];
  hardened: ScriptedToolCall[][];
  /** Provider replies in call order across all steps: intent, then proposal, per step that reaches ranking. */
  mandate: string[];
}

export interface Scenario {
  id: string;
  set: ScenarioSet;
  /** Attack category from docs/R&D.md, or the benign category. */
  category: string;
  description: string;
  /** Products the catalog holds for this scenario. Defaults to the shared fixture catalog. */
  catalog?: readonly RawProduct[];
  /** Requests in order. A repeated requestKey is a replay of the same request. */
  steps: { text: string; requestKey?: string }[];
  expect: ExpectedOutcome;
  /** Required for attacks; benign scenarios may omit it. */
  forbidden?: readonly Forbidden[];
  fake?: FakeScript;
}
