import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnthropicAdapter, LlmConfigError, loadLlmConfig } from '@mandate/llm';
import { AnthropicToolModel } from './anthropic-tools.js';
import { renderReport } from './report.js';
import { CONFIGS, type ConfigName, fakeModels, type ModelSource, runSuite } from './runner.js';
import type { ScenarioSet } from './scenario.js';
import { SAMPLE_SCENARIOS } from './scenarios/samples.js';

const SETS: readonly ScenarioSet[] = ['benign', 'attack-dev', 'attack-heldout'];
const USAGE = `Usage: pnpm eval [--live] [--sets benign,attack-dev] [--configs naive,hardened,mandate]

  --live      Use the real model (needs ANTHROPIC_API_KEY). Without it, scripted fakes test the harness only.
  --sets      Default: benign,attack-dev. attack-heldout runs only when named, and never for prompt tuning.
  --configs   Default: all three.`;

export interface CliOptions {
  live: boolean;
  sets: ScenarioSet[];
  configs: ConfigName[];
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { live: false, sets: ['benign', 'attack-dev'], configs: [...CONFIGS] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const list = () => (argv[++i] ?? '').split(',').filter(Boolean);
    if (arg === '--live') options.live = true;
    else if (arg === '--sets') {
      const sets = list();
      if (sets.length === 0 || !sets.every((s): s is ScenarioSet => (SETS as readonly string[]).includes(s))) throw new Error(USAGE);
      options.sets = sets;
    } else if (arg === '--configs') {
      const configs = list();
      if (configs.length === 0 || !configs.every((c): c is ConfigName => (CONFIGS as readonly string[]).includes(c))) throw new Error(USAGE);
      options.configs = configs;
    } else throw new Error(USAGE);
  }
  return options;
}

export function liveModels(env: Readonly<Record<string, string | undefined>>): ModelSource {
  const config = loadLlmConfig(env);
  return {
    mode: 'live',
    modelId: config.model,
    toolModel: () => new AnthropicToolModel({ model: config.model, apiKey: config.apiKey.reveal(), maxTokens: config.maxOutputTokens }),
    provider: () => AnthropicAdapter.fromConfig(config),
  };
}

export const RESULTS_DIR = fileURLToPath(new URL('../results', import.meta.url));

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.sets.includes('attack-heldout')) console.warn('Including the held-out attack set. Do not tune prompts on these results (hard rule 10).');
  const models = options.live ? liveModels(process.env) : fakeModels;
  const scenarios = SAMPLE_SCENARIOS.filter((s) => options.sets.includes(s.set));
  const run = await runSuite(scenarios, options.configs, models, {
    onCase: (c) => console.log(`${c.config.padEnd(8)} ${c.scenarioId.padEnd(36)} ${c.outcome.padEnd(8)}${c.attackSucceeded ? ' ATTACK SUCCEEDED' : ''}${c.falseBlock ? ' FALSE BLOCK' : ''}`),
  });
  // Fake runs go to a git-ignored folder: they test the harness and must never be mistaken for results.
  const dir = models.mode === 'fake' ? join(RESULTS_DIR, 'fake') : RESULTS_DIR;
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${run.runAt.replace(/[:.]/g, '-')}-${models.mode}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(`${base}.md`, renderReport(run));
  console.log(`\n${renderReport(run)}\nWrote ${base}.json and .md`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    if (error instanceof LlmConfigError) console.error(`${error.message}. Set it in .env or the shell for --live.`);
    else console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
