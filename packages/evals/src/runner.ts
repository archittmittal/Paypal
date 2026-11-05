import { FIXTURE_PRODUCTS, type RawProduct } from '@mandate/api/eval-kit';
import type { ProviderAdapter, Usage } from '@mandate/llm';
import { POLICY_VERSION } from '@mandate/policy';
import { BaselineAgent, type BaselineKind } from './configs/naive.js';
import { MandateAgent } from './configs/mandate.js';
import { ScriptedProvider, ScriptedToolModel, type ToolModel } from './models.js';
import { type Outcome, score } from './oracle.js';
import type { PaymentAttempt, Scenario, ScenarioSet } from './scenario.js';

export const CONFIGS = ['naive', 'hardened', 'mandate'] as const;
export type ConfigName = (typeof CONFIGS)[number];

/** Where model behaviour comes from. Fake mode only exercises the harness and its results are never reported. */
export interface ModelSource {
  mode: 'fake' | 'live';
  modelId: string;
  toolModel(scenario: Scenario, kind: BaselineKind): ToolModel;
  provider(scenario: Scenario): ProviderAdapter;
}

/** Replays each scenario's scripted replies. Scenarios without a script are not runnable in fake mode. */
export const fakeModels: ModelSource = {
  mode: 'fake',
  modelId: 'scripted',
  toolModel: (scenario, kind) => new ScriptedToolModel(scenario.fake?.[kind] ?? []),
  provider: (scenario) => new ScriptedProvider(scenario.fake?.mandate ?? []),
};

export interface CaseResult {
  scenarioId: string;
  set: ScenarioSet;
  category: string;
  config: ConfigName;
  outcome: Outcome;
  taskSuccess: boolean;
  attackSucceeded: boolean;
  falseBlock: boolean;
  payments: PaymentAttempt[];
  /** Per step: the Mandate request status, or the baseline's outcome. */
  steps: string[];
  latencyMs: number[];
  usage: Usage;
  /** Error class name (and code, if any) when a step threw. Never a message, which may carry model text. */
  errors: string[];
}

function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name}:${code}` : error.name;
}

export async function runCase(scenario: Scenario, config: ConfigName, models: ModelSource, now: () => number = () => performance.now()): Promise<CaseResult> {
  const catalog: readonly RawProduct[] = scenario.catalog ?? FIXTURE_PRODUCTS;
  const outcomes: Outcome[] = [];
  const payments: PaymentAttempt[] = [];
  const steps: string[] = [];
  const latencyMs: number[] = [];
  const errors: string[] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };

  const record = (outcome: Outcome, label: string, started: number, payment?: PaymentAttempt) => {
    latencyMs.push(Math.round(now() - started));
    outcomes.push(outcome);
    steps.push(label);
    if (payment) payments.push(payment);
  };

  if (config === 'mandate') {
    const agent = await MandateAgent.create({ adapter: models.provider(scenario), catalog });
    try {
      for (const [index, step] of scenario.steps.entries()) {
        const started = now();
        try {
          const result = await agent.handle(step.text, step.requestKey ?? `eval-${scenario.id}-${index}`);
          record(result.outcome, result.status, started, result.payment);
        } catch (error) {
          errors.push(errorLabel(error));
          record('error', 'error', started);
        }
      }
      usage = { ...agent.usage };
    } finally {
      await agent.close();
    }
  } else {
    const agent = new BaselineAgent(models.toolModel(scenario, config), config, catalog);
    for (const step of scenario.steps) {
      const started = now();
      try {
        const result = await agent.handle(step.text);
        usage = { inputTokens: usage.inputTokens + result.usage.inputTokens, outputTokens: usage.outputTokens + result.usage.outputTokens };
        record(result.outcome, result.outcome, started, result.payment);
      } catch (error) {
        errors.push(errorLabel(error));
        record('error', 'error', started);
      }
    }
  }

  const scored = score(scenario, outcomes, payments, catalog);
  return { scenarioId: scenario.id, set: scenario.set, category: scenario.category, config, ...scored, payments, steps, latencyMs, usage, errors };
}

export interface Metrics {
  cases: number;
  taskSuccessRate: number;
  /** Attack sets only; null for benign. */
  attackSuccessRate: number | null;
  /** Benign only; null for attack sets. */
  falseBlockRate: number | null;
  errors: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  inputTokens: number;
  outputTokens: number;
}

/** Nearest-rank percentile. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
}

const rate = (count: number, total: number) => (total === 0 ? 0 : count / total);

export function summarize(cases: readonly CaseResult[]): Metrics {
  const attack = cases.filter((c) => c.set !== 'benign');
  const benign = cases.filter((c) => c.set === 'benign');
  const latencies = cases.flatMap((c) => c.latencyMs);
  return {
    cases: cases.length,
    taskSuccessRate: rate(cases.filter((c) => c.taskSuccess).length, cases.length),
    attackSuccessRate: attack.length === 0 ? null : rate(attack.filter((c) => c.attackSucceeded).length, attack.length),
    falseBlockRate: benign.length === 0 ? null : rate(benign.filter((c) => c.falseBlock).length, benign.length),
    errors: cases.filter((c) => c.errors.length > 0).length,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    inputTokens: cases.reduce((sum, c) => sum + c.usage.inputTokens, 0),
    outputTokens: cases.reduce((sum, c) => sum + c.usage.outputTokens, 0),
  };
}

export interface RunResult {
  schemaVersion: 1;
  runAt: string;
  mode: ModelSource['mode'];
  model: string;
  policyVersion: string;
  sets: ScenarioSet[];
  configs: ConfigName[];
  /** summary[config][set] */
  summary: Record<string, Record<string, Metrics>>;
  cases: CaseResult[];
}

export async function runSuite(
  scenarios: readonly Scenario[],
  configs: readonly ConfigName[],
  models: ModelSource,
  options: { now?: () => Date; onCase?: (result: CaseResult) => void } = {},
): Promise<RunResult> {
  const runnable = models.mode === 'fake' ? scenarios.filter((s) => s.fake !== undefined) : scenarios;
  const cases: CaseResult[] = [];
  for (const scenario of runnable) {
    for (const config of configs) {
      const result = await runCase(scenario, config, models);
      cases.push(result);
      options.onCase?.(result);
    }
  }
  const sets = [...new Set(runnable.map((s) => s.set))];
  const summary: RunResult['summary'] = {};
  for (const config of configs) {
    summary[config] = {};
    for (const set of sets) summary[config][set] = summarize(cases.filter((c) => c.config === config && c.set === set));
  }
  return {
    schemaVersion: 1,
    runAt: (options.now ?? (() => new Date()))().toISOString(),
    mode: models.mode,
    model: models.modelId,
    policyVersion: POLICY_VERSION,
    sets,
    configs: [...configs],
    summary,
    cases,
  };
}
