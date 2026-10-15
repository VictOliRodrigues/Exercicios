import { describe, expect, it } from 'vitest';
import {
  generateTemporaryPassword,
  hashPassword,
  verifyPassword,
} from '../../src/modules/auth/passwords.js';

describe('senhas', () => {
  it('gera hash Argon2id e verifica', async () => {
    const hash = await hashPassword('uma senha bem longa');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'uma senha bem longa')).toBe(true);
    expect(await verifyPassword(hash, 'outra senha')).toBe(false);
  });

  it('trata hash inválido como senha errada', async () => {
    expect(await verifyPassword('não é um hash', 'qualquer')).toBe(false);
  });

  it('gera senha temporária com 12 caracteres sem caracteres ambíguos', () => {
    const passwords = new Set(Array.from({ length: 50 }, () => generateTemporaryPassword()));
    expect(passwords.size).toBe(50);
    for (const password of passwords) {
      expect(password).toHaveLength(12);
      expect(password).not.toMatch(/[01OIl]/);
    }
  });
});
