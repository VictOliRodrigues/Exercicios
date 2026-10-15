import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvError, isCookieSecure, parseEnv } from '../../src/config/env.js';

const valid = () => ({
  DATABASE_URL: 'mysql://app:senha@localhost:3306/simulados',
  SESSION_SECRET: 'x'.repeat(40),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
});

describe('variáveis de ambiente', () => {
  it('aceita o mínimo e aplica os padrões', () => {
    const env = parseEnv(valid());
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOGIN_MAX_FAILS).toBe(5);
    expect(env.SESSION_IDLE_HOURS).toBe(8);
  });

  it('acusa variável obrigatória ausente, tratando valor vazio como ausente', () => {
    const error = captureError(() => parseEnv({ ...valid(), ENCRYPTION_KEY: '' }));
    expect(error.problems.some((p) => p.startsWith('ENCRYPTION_KEY'))).toBe(true);
  });

  it('recusa chave de criptografia com tamanho errado sem mostrar o valor', () => {
    const key = randomBytes(16).toString('base64');
    const error = captureError(() => parseEnv({ ...valid(), ENCRYPTION_KEY: key }));
    expect(error.message).toContain('32 bytes');
    expect(error.message).not.toContain(key);
  });

  it('recusa SESSION_SECRET curto e DATABASE_URL que não é mysql', () => {
    const error = captureError(() =>
      parseEnv({ ...valid(), SESSION_SECRET: 'curto', DATABASE_URL: 'postgres://x' }),
    );
    expect(error.problems).toHaveLength(2);
  });

  it('cookie seguro em produção, com opção de desligar para teste local', () => {
    expect(isCookieSecure(parseEnv({ ...valid(), NODE_ENV: 'production' }))).toBe(true);
    expect(isCookieSecure(parseEnv(valid()))).toBe(false);
    expect(
      isCookieSecure(parseEnv({ ...valid(), NODE_ENV: 'production', COOKIE_SECURE: 'false' })),
    ).toBe(false);
  });
});

function captureError(fn: () => unknown): EnvError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvError) return error;
    throw error;
  }
  throw new Error('Era esperado um EnvError');
}
