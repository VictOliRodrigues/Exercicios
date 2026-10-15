import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Keyring } from './keys.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + IV_LENGTH + TAG_LENGTH;

export type CipherPurpose = 'db' | 'files';

export class DecryptionError extends Error {
  constructor() {
    super('Falha ao decifrar: dado adulterado, chave errada ou AAD diferente');
    this.name = 'DecryptionError';
  }
}

/** Layout: versão da chave (1 byte) | IV (12) | tag (16) | dados. */
export function encrypt(
  keyring: Keyring,
  purpose: CipherPurpose,
  plaintext: Buffer,
  aad: string,
): Buffer {
  const version = keyring.currentVersion;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyring.get(version)[purpose], iv, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([version]), iv, cipher.getAuthTag(), body]);
}

export function decrypt(
  keyring: Keyring,
  purpose: CipherPurpose,
  payload: Buffer,
  aad: string,
): Buffer {
  if (payload.length < HEADER_LENGTH) throw new DecryptionError();
  const version = payload[0]!;
  const iv = payload.subarray(1, 1 + IV_LENGTH);
  const tag = payload.subarray(1 + IV_LENGTH, HEADER_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, keyring.get(version)[purpose], iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(payload.subarray(HEADER_LENGTH)), decipher.final()]);
  } catch {
    throw new DecryptionError();
  }
}
