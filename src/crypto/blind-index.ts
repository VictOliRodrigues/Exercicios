import { createHmac } from 'node:crypto';
import type { Keyring } from './keys.js';

export type IndexKind = 'email';

export function normalizeEmail(email: string): string {
  return email.normalize('NFC').trim().toLowerCase();
}

/**
 * Índice de busca (blind index): permite achar um valor criptografado sem decifrar nada.
 * O prefixo do tipo impede que índices de campos diferentes coincidam.
 */
export function blindIndex(keyring: Keyring, kind: IndexKind, normalizedValue: string): string {
  return createHmac('sha256', keyring.get(keyring.currentVersion).index)
    .update(`${kind}:${normalizedValue}`)
    .digest('hex');
}
