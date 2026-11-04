import { describe, expect, it } from 'vitest';
import { assertNoTransactionControl, checksum, loadMigrations, MigrationError, type MigrationFile, parseMigrations, planMigrations, topLevelStatements } from '../src/migrations.js';

const file = (filename: string, sql = 'SELECT 1;') => ({ filename, sql });
const applied = (m: MigrationFile) => ({ version: m.version, name: m.name, checksum: m.checksum });

describe('parseMigrations', () => {
  it('orders by version and ignores non-SQL files', () => {
    const parsed = parseMigrations([file('0002_b.sql'), file('README.md'), file('0001_a.sql')]);
    expect(parsed.map((m) => `${m.version}_${m.name}`)).toEqual(['0001_a', '0002_b']);
  });

  it.each([
    ['a gap', [file('0001_a.sql'), file('0003_c.sql')]],
    ['a duplicate version', [file('0001_a.sql'), file('0001_b.sql')]],
    ['not starting at 0001', [file('0002_b.sql')]],
    ['a bad file name', [file('1_a.sql')]],
    ['upper case in the name', [file('0001_Add.sql')]],
  ])('rejects %s', (_label, files) => {
    expect(() => parseMigrations(files)).toThrow(MigrationError);
  });

  it('checksums ignore CRLF versus LF and a leading byte-order mark, but nothing else', () => {
    expect(checksum('a;\r\nb;\r\n')).toBe(checksum('a;\nb;\n'));
    expect(checksum('\uFEFFa;\nb;\n')).toBe(checksum('a;\nb;\n'));
    expect(checksum('a;\nb;\n')).not.toBe(checksum('a;\nb; \n'));
  });
});

describe('planMigrations', () => {
  const files = parseMigrations([file('0001_a.sql', 'A;'), file('0002_b.sql', 'B;')]);
  const [first, second] = files as [MigrationFile, MigrationFile];

  it('returns only what has not been applied', () => {
    expect(planMigrations(files, [])).toEqual(files);
    expect(planMigrations(files, [applied(first)])).toEqual([second]);
    expect(planMigrations(files, [applied(first), applied(second)])).toEqual([]);
  });

  it('refuses an edited migration', () => {
    expect(() => planMigrations(files, [{ ...applied(first), checksum: 'other' }])).toThrow(/changed after it was applied/);
    expect(() => planMigrations(files, [{ ...applied(first), name: 'renamed' }])).toThrow(MigrationError);
  });

  it('refuses a database that is ahead of the checkout', () => {
    expect(() => planMigrations(files, [{ version: '0003', name: 'c', checksum: 'x' }])).toThrow(/update your branch/);
  });
});

describe('repository migrations', () => {
  const migrations = loadMigrations();

  it('are numbered 0001.. without gaps', () => {
    expect(migrations.map((m) => m.version)).toEqual(migrations.map((_m, i) => String(i + 1).padStart(4, '0')));
    expect(migrations.length).toBeGreaterThanOrEqual(2);
  });

  it('never declare inexact numeric types (money is bigint minor units)', () => {
    for (const migration of migrations) {
      const code = migration.sql.replace(/--.*$/gm, '');
      expect(code, migration.name).not.toMatch(/\b(?:real|double\s+precision|float\d?|numeric|decimal|money)\b/i);
    }
  });

  it('are ASCII only, like the TypeScript sources', () => {
    for (const migration of migrations) expect([...migration.sql].every((c) => (c.codePointAt(0) ?? 0) <= 0x7f), migration.name).toBe(true);
  });
});

describe('assertNoTransactionControl (review finding L2)', () => {
  it.each([
    ['COMMIT', 'CREATE TABLE t1 (id int); COMMIT; CREATE TABLE t2 (id int);'],
    ['BEGIN', 'BEGIN; CREATE TABLE t (id int);'],
    ['ROLLBACK', 'CREATE TABLE t (id int);\nROLLBACK;'],
    ['END', 'END;'],
    ['START TRANSACTION', 'start transaction; select 1;'],
    ['SAVEPOINT', 'SAVEPOINT a;'],
  ])('rejects a file containing %s', (_label, sql) => {
    expect(() => assertNoTransactionControl('0009_x.sql', sql)).toThrow(/transaction-control statement/);
  });

  it('ignores the same words inside function bodies, strings and comments', () => {
    const sql = [
      "-- COMMIT; in a comment",
      "/* ROLLBACK; in a block comment */",
      "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END; $$;",
      "CREATE FUNCTION g() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN RETURN; END; $body$;",
      "SELECT 'COMMIT; inside a string';",
      "COMMENT ON TABLE t IS 'it''s fine; END;';",
    ].join('\n');
    expect(() => assertNoTransactionControl('0009_x.sql', sql)).not.toThrow();
  });

  // Second review finding L4: the old regex pipeline stripped comments before strings, so these slipped through.
  it.each([
    ['a -- inside a string before COMMIT', "SELECT '--'; COMMIT;"],
    ['a block comment holding -- before COMMIT', 'SELECT 1 /* -- */; COMMIT;'],
    ['a quote inside a comment', "-- it's\nCOMMIT;"],
    ['a quote inside a block comment', "/* ' */ COMMIT; SELECT '';"],
    ['an E-string with an escaped quote', "SELECT E'\\''; COMMIT;"],
    ['a nested block comment', 'SELECT 1 /* outer /* inner */ still comment */; COMMIT;'],
    ['a line comment ended by a lone carriage return', 'CREATE TABLE t (); -- note\rCOMMIT; SELECT 1 / 0;'],
    ['a quoted identifier holding a quote', 'SELECT 1 AS "a\'b"; COMMIT;'],
    ['COMMIT after a tagged dollar-quoted body', 'DO $f$ BEGIN PERFORM 1; END $f$; COMMIT;'],
  ])('rejects COMMIT hidden by %s', (_label, sql) => {
    expect(() => assertNoTransactionControl('0009_x.sql', sql)).toThrow(/transaction-control statement/);
  });

  it('ends a dollar quote at its tag, as the server does, even inside what looks like a string', () => {
    // The server reads $$ BEGIN PERFORM '$$ as the whole body; what follows opens a string that never closes.
    expect(() => topLevelStatements("DO $$ BEGIN PERFORM '$$'; END $$; COMMIT;")).toThrow(/unterminated string/);
  });

  it('does not mistake identifiers containing $ or positional parameters for dollar quotes', () => {
    expect(topLevelStatements('SELECT a$b FROM t WHERE x = $1; SELECT 2')).toEqual(['SELECT a$b FROM t WHERE x = $1', 'SELECT 2']);
  });

  it('refuses unterminated strings, identifiers, comments and dollar quotes rather than guess', () => {
    for (const sql of ["SELECT 'open", 'SELECT "open', 'SELECT 1 /* open', 'DO $x$ BEGIN END']) {
      expect(() => topLevelStatements(sql), sql).toThrow(/unterminated/);
    }
  });

  it('accepts every migration in the repository', () => {
    expect(() => loadMigrations()).not.toThrow();
  });
});
