import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Hard rule 7 applied to the deploy config: a secret in render.yaml would be committed to git.
// Every secret-looking variable must be `sync: false` (entered in the Render dashboard) or come from the database.

const SECRET_NAME = /(SECRET|PASSWORD|TOKEN|API_KEY|CLIENT_ID|DATABASE_URL)/;

export function envEntries(yaml: string): { key: string; body: string }[] {
  const lines = yaml.split(/\r?\n/);
  return lines.flatMap((line, index) => {
    const match = /^(\s*)- key: (\S+)\s*$/.exec(line);
    if (!match?.[2]) return [];
    const indent = (match[1] ?? '').length;
    const body: string[] = [];
    for (const next of lines.slice(index + 1)) {
      const nextIndent = next.length - next.trimStart().length;
      if (next.trim() === '' || next.trimStart().startsWith('#')) continue;
      if (nextIndent <= indent) break;
      body.push(next.trim());
    }
    return [{ key: match[2], body: body.join('\n') }];
  });
}

describe('render.yaml', () => {
  const yaml = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');

  it('finds the env entries', () => {
    expect(envEntries(yaml).map((e) => e.key)).toEqual(expect.arrayContaining(['DATABASE_URL', 'PAYPAL_CLIENT_SECRET', 'HOST']));
  });

  it('never gives a secret a literal value', () => {
    const offenders = envEntries(yaml)
      .filter((e) => SECRET_NAME.test(e.key))
      .filter((e) => !/^sync: false$/m.test(e.body) && !/^fromDatabase:/m.test(e.body))
      .map((e) => e.key);
    expect(offenders).toEqual([]);
  });

  it('flags a secret with a literal value', () => {
    const bad = '    envVars:\n      - key: PAYPAL_CLIENT_SECRET\n        value: abc\n';
    const entries = envEntries(bad).filter((e) => !/^sync: false$/m.test(e.body));
    expect(entries.map((e) => e.key)).toEqual(['PAYPAL_CLIENT_SECRET']);
  });

  it('binds the API to 0.0.0.0 and keeps the database private', () => {
    expect(envEntries(yaml).find((e) => e.key === 'HOST')?.body).toBe('value: 0.0.0.0');
    expect(yaml).toMatch(/^\s*ipAllowList: \[\]\s*$/m);
  });
});
