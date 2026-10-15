import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { normalizeEmail } from '../../crypto/blind-index.js';
import type { CryptoService } from '../../crypto/index.js';
import type { Database } from '../../db/client.js';
import { users, type UserRow } from '../../db/schema.js';
import { hashPassword } from '../auth/passwords.js';

export type Role = UserRow['role'];

export interface NewUser {
  name: string;
  email: string;
  phone?: string | null;
  password: string;
  role: Role;
  mustChangePassword: boolean;
}

export async function createUser(db: Database, crypto: CryptoService, input: NewUser) {
  const id = uuidv7();
  const now = new Date();
  await db.insert(users).values({
    id,
    emailIdx: crypto.emailIndex(input.email),
    emailEnc: crypto.encryptField(normalizeEmail(input.email), 'users', 'email', id),
    nameEnc: crypto.encryptField(input.name.trim(), 'users', 'name', id),
    phoneEnc: input.phone ? crypto.encryptField(input.phone, 'users', 'phone', id) : null,
    passwordHash: await hashPassword(input.password),
    role: input.role,
    mustChangePassword: input.mustChangePassword,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function findUserByEmail(db: Database, crypto: CryptoService, email: string) {
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.emailIdx, crypto.emailIndex(email)))
    .limit(1);
  return row;
}

export async function findUserById(db: Database, id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row;
}

export function decryptName(crypto: CryptoService, row: Pick<UserRow, 'id' | 'nameEnc'>) {
  return crypto.decryptField(row.nameEnc, 'users', 'name', row.id);
}

export function decryptEmail(crypto: CryptoService, row: Pick<UserRow, 'id' | 'emailEnc'>) {
  return crypto.decryptField(row.emailEnc, 'users', 'email', row.id);
}

/** Troca a senha e derruba todas as sessões abertas. Devolve a nova versão de sessão. */
export async function setPassword(
  db: Database,
  userId: string,
  password: string,
  options: { mustChangePassword: boolean },
): Promise<number> {
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      mustChangePassword: options.mustChangePassword,
      sessionVersion: sql`${users.sessionVersion} + 1`,
      failedLogins: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
  const row = await findUserById(db, userId);
  if (!row) throw new Error('Usuário não encontrado depois de trocar a senha');
  return row.sessionVersion;
}
