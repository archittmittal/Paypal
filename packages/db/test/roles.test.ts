import { describe, expect, it } from 'vitest';
import { scramVerifier } from '../src/roles.js';

describe('scramVerifier', () => {
  it('produces the SCRAM-SHA-256 format Postgres stores, with a fresh salt each time', () => {
    const verifier = scramVerifier('correct-horse-battery-staple');
    expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(scramVerifier('correct-horse-battery-staple')).not.toBe(verifier);
  });

  it('is deterministic for a given salt and never contains the password', () => {
    const salt = Buffer.alloc(16, 7);
    expect(scramVerifier('correct-horse-battery-staple', salt)).toBe(scramVerifier('correct-horse-battery-staple', salt));
    expect(scramVerifier('correct-horse-battery-staple', salt)).not.toContain('horse');
  });

  it.each(['short', 'has a space in it!!', 'non-ascii-passw\u00f6rd-1234'])('rejects %j', (password) => {
    expect(() => scramVerifier(password)).toThrow(RangeError);
  });

  it('accepts quotes: only the verifier, never the password, reaches SQL', () => {
    expect(() => scramVerifier("quote'injection--x")).not.toThrow();
  });
});
