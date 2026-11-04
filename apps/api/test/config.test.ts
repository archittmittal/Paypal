import { describe, expect, it } from 'vitest';
import { ApiConfigError, loadApiConfig } from '../src/config.js';

describe('loadApiConfig', () => {
  it('defaults to loopback, port 3000 and info logging', () => {
    expect(loadApiConfig({})).toEqual({ port: 3000, host: '127.0.0.1', logLevel: 'info' });
  });

  it('reads PORT, HOST and LOG_LEVEL', () => {
    expect(loadApiConfig({ PORT: '10000', HOST: '0.0.0.0', LOG_LEVEL: 'debug' })).toEqual({
      port: 10000,
      host: '0.0.0.0',
      logLevel: 'debug',
    });
  });

  it('treats empty values as unset', () => {
    expect(loadApiConfig({ PORT: '', HOST: '', LOG_LEVEL: '' })).toEqual(loadApiConfig({}));
  });

  it('reads an optional DATABASE_URL', () => {
    expect(loadApiConfig({}).databaseUrl).toBeUndefined();
    expect(loadApiConfig({ DATABASE_URL: 'postgresql://db.example.invalid:5432/mandate' }).databaseUrl).toBe('postgresql://db.example.invalid:5432/mandate');
  });

  it('rejects a DATABASE_URL that is not postgres, without printing it', () => {
    expect(() => loadApiConfig({ DATABASE_URL: 'mysql://db.example.invalid/LEAK-MARKER' })).toThrow('Invalid API configuration: DATABASE_URL');
    expect(() => loadApiConfig({ DATABASE_URL: 'mysql://db.example.invalid/LEAK-MARKER' })).not.toThrow(/LEAK-MARKER/);
  });

  it('ignores unrelated variables', () => {
    expect(loadApiConfig({ PAYPAL_CLIENT_SECRET: 'x', PATH: '/usr/bin' }).port).toBe(3000);
  });

  it.each([
    ['a non-numeric port', { PORT: 'http' }, ['PORT']],
    ['a port out of range', { PORT: '70000' }, ['PORT']],
    ['a fractional port', { PORT: '30.5' }, ['PORT']],
    ['an unknown log level', { LOG_LEVEL: 'verbose' }, ['LOG_LEVEL']],
    ['several at once', { PORT: '0', LOG_LEVEL: 'loud' }, ['PORT', 'LOG_LEVEL']],
  ])('rejects %s, naming the variables only', (_label, env, variables) => {
    try {
      loadApiConfig(env);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiConfigError);
      expect((error as ApiConfigError).variables).toEqual(variables);
      for (const value of Object.values(env)) expect((error as Error).message).not.toContain(`=${value}`);
    }
  });
});
