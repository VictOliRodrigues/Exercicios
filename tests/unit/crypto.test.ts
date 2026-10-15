import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, DecryptionError, encrypt } from '../../src/crypto/cipher.js';
import { createCryptoService } from '../../src/crypto/index.js';
import { createKeyring, deriveKeySet } from '../../src/crypto/keys.js';

const newKey = () => randomBytes(32).toString('base64');

describe('criptografia de campos', () => {
  const crypto = createCryptoService(createKeyring(newKey(), 1));

  it('cifra e decifra o mesmo valor', () => {
    const stored = crypto.encryptField('Maria da Silva', 'users', 'name', 'id-1');
    expect(stored).not.toContain('Maria');
    expect(crypto.decryptField(stored, 'users', 'name', 'id-1')).toBe('Maria da Silva');
  });

  it('gera um texto cifrado diferente a cada vez (IV aleatório)', () => {
    const a = crypto.encryptField('igual', 'users', 'name', 'id-1');
    const b = crypto.encryptField('igual', 'users', 'name', 'id-1');
    expect(a).not.toBe(b);
  });

  it('recusa dado adulterado', () => {
    const stored = Buffer.from(crypto.encryptField('segredo', 'users', 'name', 'id-1'), 'base64');
    stored[stored.length - 1]! ^= 0xff;
    expect(() => crypto.decryptField(stored.toString('base64'), 'users', 'name', 'id-1')).toThrow(
      DecryptionError,
    );
  });

  it('recusa valor copiado para outra linha ou outra coluna (AAD)', () => {
    const stored = crypto.encryptField('segredo', 'users', 'name', 'id-1');
    expect(() => crypto.decryptField(stored, 'users', 'name', 'id-2')).toThrow(DecryptionError);
    expect(() => crypto.decryptField(stored, 'users', 'email', 'id-1')).toThrow(DecryptionError);
  });

  it('recusa chave diferente', () => {
    const other = createCryptoService(createKeyring(newKey(), 1));
    const stored = crypto.encryptField('segredo', 'users', 'name', 'id-1');
    expect(() => other.decryptField(stored, 'users', 'name', 'id-1')).toThrow(DecryptionError);
  });

  it('grava a versão da chave e recusa versão desconhecida', () => {
    const keyring = createKeyring(newKey(), 7);
    const payload = encrypt(keyring, 'db', Buffer.from('x'), 'aad');
    expect(payload[0]).toBe(7);
    payload[0] = 8;
    expect(() => decrypt(keyring, 'db', payload, 'aad')).toThrow('versão 8');
  });

  it('recusa payload curto demais', () => {
    expect(() => crypto.decryptField('AAAA', 'users', 'name', 'id-1')).toThrow(DecryptionError);
  });
});

describe('chaves', () => {
  it('deriva subchaves diferentes para cada uso', () => {
    const keys = deriveKeySet(randomBytes(32));
    expect(keys.db.equals(keys.files)).toBe(false);
    expect(keys.db.equals(keys.index)).toBe(false);
    expect(keys.files.equals(keys.index)).toBe(false);
  });

  it('recusa chave mestra que não tem 32 bytes', () => {
    expect(() => createKeyring(randomBytes(16).toString('base64'), 1)).toThrow('32 bytes');
  });

  it('usa chaves separadas para banco e arquivos', () => {
    const keyring = createKeyring(newKey(), 1);
    const payload = encrypt(keyring, 'db', Buffer.from('x'), 'aad');
    expect(() => decrypt(keyring, 'files', payload, 'aad')).toThrow(DecryptionError);
  });
});

describe('índice de busca do e-mail', () => {
  const crypto = createCryptoService(createKeyring(newKey(), 1));

  it('ignora maiúsculas e espaços', () => {
    expect(crypto.emailIndex(' Fulano@Exemplo.COM ')).toBe(crypto.emailIndex('fulano@exemplo.com'));
  });

  it('é diferente para e-mails diferentes e não contém o e-mail', () => {
    const index = crypto.emailIndex('fulano@exemplo.com');
    expect(index).toMatch(/^[0-9a-f]{64}$/);
    expect(index).not.toBe(crypto.emailIndex('ciclano@exemplo.com'));
  });

  it('depende da chave', () => {
    const other = createCryptoService(createKeyring(newKey(), 1));
    expect(other.emailIndex('fulano@exemplo.com')).not.toBe(
      crypto.emailIndex('fulano@exemplo.com'),
    );
  });
});
