import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  NODE_ENV: 'development',
  APP_BASE_URL: 'http://localhost:3001',
  DATABASE_URL: 'postgres://x',
  SESSION_SECRET: 'a'.repeat(64),
  BREAK_GLASS_KEY: 'b'.repeat(64),
  AUTH_MODE: 'dev',
};

describe('config (A.8.9 fail-fast, A.5.16 production auth)', () => {
  it('accepts a valid dev configuration', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.AUTH_MODE).toBe('dev');
    expect(cfg.session.idleMinutes).toBe(30);
    expect(cfg.session.absoluteHours).toBe(8);
  });

  it('REFUSES dev auth in production — the stub must be impossible to ship', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/AUTH_MODE/);
  });

  it('requires all Entra settings when AUTH_MODE=entra', () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: 'entra' })).toThrow(/ENTRA_TENANT_ID/);
  });

  it('accepts entra mode with full settings', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://purchasing.massymotors.local',
      AUTH_MODE: 'entra',
      ENTRA_TENANT_ID: 't',
      ENTRA_CLIENT_ID: 'c',
      ENTRA_CLIENT_SECRET: 's',
      OIDC_REDIRECT_URI: 'https://purchasing.massymotors.local/api/auth/callback',
    });
    expect(cfg.AUTH_MODE).toBe('entra');
  });

  it('rejects weak session secrets', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/64 hex/);
  });

  it('rejects plain-http APP_BASE_URL in production (A.5.14)', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        AUTH_MODE: 'entra',
        ENTRA_TENANT_ID: 't',
        ENTRA_CLIENT_ID: 'c',
        ENTRA_CLIENT_SECRET: 's',
        OIDC_REDIRECT_URI: 'https://x/api/auth/callback',
      }),
    ).toThrow(/https/);
  });

  it('refuses TRUST_PROXY=true — proxies must be named explicitly', () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.1,10.0.0.2' }).trustProxy).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(loadConfig({ ...base }).trustProxy).toBe(false);
  });
});
