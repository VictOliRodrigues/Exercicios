import { blindIndex, normalizeEmail } from './blind-index.js';
import { decrypt, encrypt } from './cipher.js';
import type { Keyring } from './keys.js';

export interface CryptoService {
  /** Cifra um campo do banco. O AAD amarra o valor à tabela, à coluna e à linha. */
  encryptField(value: string, table: string, column: string, id: string): string;
  decryptField(stored: string, table: string, column: string, id: string): string;
  emailIndex(email: string): string;
  encryptFile(content: Buffer, storageKey: string): Buffer;
  decryptFile(payload: Buffer, storageKey: string): Buffer;
}

const fieldAad = (table: string, column: string, id: string) => `${table}.${column}:${id}`;

export function createCryptoService(keyring: Keyring): CryptoService {
  return {
    encryptField(value, table, column, id) {
      return encrypt(
        keyring,
        'db',
        Buffer.from(value, 'utf8'),
        fieldAad(table, column, id),
      ).toString('base64');
    },
    decryptField(stored, table, column, id) {
      return decrypt(
        keyring,
        'db',
        Buffer.from(stored, 'base64'),
        fieldAad(table, column, id),
      ).toString('utf8');
    },
    emailIndex(email) {
      return blindIndex(keyring, 'email', normalizeEmail(email));
    },
    encryptFile(content, storageKey) {
      return encrypt(keyring, 'files', content, `file:${storageKey}`);
    },
    decryptFile(payload, storageKey) {
      return decrypt(keyring, 'files', payload, `file:${storageKey}`);
    },
  };
}
