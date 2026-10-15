import { randomBytes, randomInt } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';

export const PASSWORD_MIN_LENGTH = 10;
export const ADMIN_SEED_PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

// Parâmetros mínimos recomendados pelo OWASP para Argon2id.
const HASH_OPTIONS = { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Gasta o mesmo tempo de uma verificação real, para o login não revelar quem está cadastrado. */
export async function spendPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(await dummyHash, password);
}

// Sem caracteres ambíguos (0/O, 1/l/I), para facilitar ditar ou digitar a senha.
const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export function generateTemporaryPassword(length = 12): string {
  let password = '';
  for (let i = 0; i < length; i++) password += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
  return password;
}
