import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { normalizeEmail } from '../../crypto/blind-index.js';
import type { CryptoService } from '../../crypto/index.js';
import type { Database } from '../../db/client.js';
import { studyGroupMembers, studyGroups, users, type UserRow } from '../../db/schema.js';
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

export interface UserProfile {
  name: string;
  email: string;
  phone: string;
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

/** Usuário comum (não admin) pelo id; é o único tipo que o admin gerencia pelas telas. */
export async function findManagedUser(db: Database, id: string) {
  const row = await findUserById(db, id);
  return row?.role === 'user' ? row : undefined;
}

export async function isEmailTaken(
  db: Database,
  crypto: CryptoService,
  email: string,
  exceptUserId?: string,
): Promise<boolean> {
  const row = await findUserByEmail(db, crypto, email);
  return Boolean(row && row.id !== exceptUserId);
}

export function decryptName(crypto: CryptoService, row: Pick<UserRow, 'id' | 'nameEnc'>) {
  return crypto.decryptField(row.nameEnc, 'users', 'name', row.id);
}

export function decryptEmail(crypto: CryptoService, row: Pick<UserRow, 'id' | 'emailEnc'>) {
  return crypto.decryptField(row.emailEnc, 'users', 'email', row.id);
}

export function decryptPhone(crypto: CryptoService, row: Pick<UserRow, 'id' | 'phoneEnc'>) {
  return row.phoneEnc ? crypto.decryptField(row.phoneEnc, 'users', 'phone', row.id) : null;
}

export async function updateUserProfile(
  db: Database,
  crypto: CryptoService,
  id: string,
  profile: UserProfile,
): Promise<void> {
  await db
    .update(users)
    .set({
      emailIdx: crypto.emailIndex(profile.email),
      emailEnc: crypto.encryptField(normalizeEmail(profile.email), 'users', 'email', id),
      nameEnc: crypto.encryptField(profile.name, 'users', 'name', id),
      phoneEnc: crypto.encryptField(profile.phone, 'users', 'phone', id),
      updatedAt: new Date(),
    })
    .where(eq(users.id, id));
}

/** Desativar derruba as sessões abertas; os dados e o histórico ficam. */
export async function setUserActive(db: Database, id: string, active: boolean): Promise<void> {
  await db
    .update(users)
    .set({
      active,
      sessionVersion: sql`${users.sessionVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id));
}

/**
 * Troca a senha, encerra o pedido de "Esqueci minha senha", zera o bloqueio e derruba todas as
 * sessões abertas. Devolve a nova versão de sessão.
 */
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
      passwordResetRequestedAt: null,
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

export interface ManagedUserView {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  active: boolean;
  resetRequestedAt: Date | null;
  lastLoginAt: Date | null;
  groups: string[];
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' });

/**
 * Lista do admin: pedidos de redefinição no topo (o mais antigo primeiro), depois os ativos por
 * nome e por fim os desativados. Os nomes estão criptografados, então a ordem é feita aqui.
 */
export async function listManagedUsers(
  db: Database,
  crypto: CryptoService,
): Promise<ManagedUserView[]> {
  const rows = await db.select().from(users).where(eq(users.role, 'user'));
  const memberships = await db
    .select({
      userId: studyGroupMembers.userId,
      groupId: studyGroups.id,
      nameEnc: studyGroups.nameEnc,
    })
    .from(studyGroupMembers)
    .innerJoin(studyGroups, eq(studyGroups.id, studyGroupMembers.groupId))
    .where(isNull(studyGroups.deletedAt));

  const groupNames = new Map<string, string>();
  const groupsByUser = new Map<string, string[]>();
  for (const membership of memberships) {
    let name = groupNames.get(membership.groupId);
    if (name === undefined) {
      name = crypto.decryptField(membership.nameEnc, 'study_groups', 'name', membership.groupId);
      groupNames.set(membership.groupId, name);
    }
    groupsByUser.set(membership.userId, [...(groupsByUser.get(membership.userId) ?? []), name]);
  }

  const list = rows.map((row) => ({
    id: row.id,
    name: decryptName(crypto, row),
    email: decryptEmail(crypto, row),
    phone: decryptPhone(crypto, row),
    active: row.active,
    resetRequestedAt: row.active ? row.passwordResetRequestedAt : null,
    lastLoginAt: row.lastLoginAt,
    groups: (groupsByUser.get(row.id) ?? []).sort((a, b) => a.localeCompare(b, 'pt-BR')),
  }));

  const rank = (user: ManagedUserView) => (user.resetRequestedAt ? 0 : user.active ? 1 : 2);
  return list.sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a.resetRequestedAt && b.resetRequestedAt) {
      return a.resetRequestedAt.getTime() - b.resetRequestedAt.getTime();
    }
    return byName(a, b);
  });
}

/** Usuários ativos que ainda não estão no grupo, para o admin adicionar. */
export async function listActiveUsersOutsideGroup(
  db: Database,
  crypto: CryptoService,
  groupId: string,
) {
  const rows = await db
    .select({ id: users.id, nameEnc: users.nameEnc, emailEnc: users.emailEnc })
    .from(users)
    .leftJoin(
      studyGroupMembers,
      and(eq(studyGroupMembers.userId, users.id), eq(studyGroupMembers.groupId, groupId)),
    )
    .where(and(eq(users.role, 'user'), eq(users.active, true), isNull(studyGroupMembers.userId)));
  return rows
    .map((row) => ({
      id: row.id,
      name: decryptName(crypto, row),
      email: decryptEmail(crypto, row),
    }))
    .sort(byName);
}
