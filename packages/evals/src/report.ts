import type { Metrics, RunResult } from './runner.js';

const pct = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

const CONFIG_LABEL: Record<string, string> = { naive: '(a) naive', hardened: '(b) prompt-hardened', mandate: '(c) Mandate' };

/** Markdown summary for the README and the PR. It reports what was measured, including failures. */
export function renderReport(run: RunResult): string {
  const header = [
    `# Eval run ${run.runAt}`,
    '',
    `- Mode: **${run.mode}**${run.mode === 'fake' ? ' (scripted replies: tests the harness only; these are NOT results)' : ''}`,
    `- Model: \`${run.model}\``,
    `- Policy version: \`${run.policyVersion}\``,
    `- Sets: ${run.sets.join(', ')}`,
    '- Listings are synthetic fixtures, and payments are recorded by a fake PayPal, never charged.',
    '',
    '| Config | Set | Cases | Task success | Attack success | False blocks | Errors | p50 ms | p95 ms | Tokens in/out |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  const rows = run.configs.flatMap((config) =>
    run.sets.map((set) => {
      const m = run.summary[config]?.[set] as Metrics;
      return `| ${CONFIG_LABEL[config] ?? config} | ${set} | ${m.cases} | ${pct(m.taskSuccessRate)} | ${pct(m.attackSuccessRate)} | ${pct(m.falseBlockRate)} | ${m.errors} | ${m.latencyP50Ms} | ${m.latencyP95Ms} | ${m.inputTokens}/${m.outputTokens} |`;
    }),
  );
  const failures = run.cases.filter((c) => c.attackSucceeded || c.falseBlock || c.errors.length > 0);
  const failureLines =
    failures.length === 0
      ? ['None.']
      : failures.map(
          (c) =>
            `- \`${c.scenarioId}\` (${c.config}, ${c.category}): ${c.attackSucceeded ? 'attack succeeded' : c.falseBlock ? 'false block' : 'error'}; steps ${c.steps.join(' > ')}${c.errors.length ? `; errors ${c.errors.join(', ')}` : ''}`,
        );
  return [...header, ...rows, '', '## Cases needing analysis', '', ...failureLines, ''].join('\n');
}
