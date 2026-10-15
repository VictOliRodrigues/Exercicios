import { and, count, countDistinct, eq, inArray, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { CryptoService } from '../../crypto/index.js';
import type { Database } from '../../db/client.js';
import {
  questionBankGroups,
  questionBanks,
  studyGroupMembers,
  studyGroups,
  users,
} from '../../db/schema.js';
import { decryptEmail, decryptName } from '../users/users.service.js';

export const GROUP_NAME_MAX_LENGTH = 80;

export interface GroupSummary {
  id: string;
  name: string;
}

export function decryptGroupName(crypto: CryptoService, row: { id: string; nameEnc: string }) {
  return crypto.decryptField(row.nameEnc, 'study_groups', 'name', row.id);
}

const compareNames = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' });
const byName = (a: { name: string }, b: { name: string }) => compareNames(a.name, b.name);

/** Grupo que não foi excluído. */
export async function findGroup(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(studyGroups)
    .where(and(eq(studyGroups.id, id), isNull(studyGroups.deletedAt)))
    .limit(1);
  return row;
}

/** Os nomes estão criptografados: a comparação (sem maiúsculas nem acentos) é feita aqui. */
export async function isGroupNameTaken(
  db: Database,
  crypto: CryptoService,
  name: string,
  exceptGroupId?: string,
): Promise<boolean> {
  const rows = await db.select().from(studyGroups).where(isNull(studyGroups.deletedAt));
  return rows.some(
    (row) => row.id !== exceptGroupId && compareNames(decryptGroupName(crypto, row), name) === 0,
  );
}

export async function createGroup(db: Database, crypto: CryptoService, name: string) {
  const id = uuidv7();
  const now = new Date();
  await db.insert(studyGroups).values({
    id,
    nameEnc: crypto.encryptField(name, 'study_groups', 'name', id),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function renameGroup(db: Database, crypto: CryptoService, id: string, name: string) {
  await db
    .update(studyGroups)
    .set({ nameEnc: crypto.encryptField(name, 'study_groups', 'name', id), updatedAt: new Date() })
    .where(eq(studyGroups.id, id));
}

/** Lista do admin: nome, número de membros e número de simulados compartilhados. */
export async function listGroupsForAdmin(db: Database, crypto: CryptoService) {
  const rows = await db.select().from(studyGroups).where(isNull(studyGroups.deletedAt));
  const members = await db
    .select({ groupId: studyGroupMembers.groupId, total: count() })
    .from(studyGroupMembers)
    .groupBy(studyGroupMembers.groupId);
  const banks = await db
    .select({
      groupId: questionBankGroups.groupId,
      total: countDistinct(questionBankGroups.bankId),
    })
    .from(questionBankGroups)
    .innerJoin(questionBanks, eq(questionBanks.id, questionBankGroups.bankId))
    .where(isNull(questionBanks.deletedAt))
    .groupBy(questionBankGroups.groupId);

  const memberCount = new Map(members.map((row) => [row.groupId, row.total]));
  const bankCount = new Map(banks.map((row) => [row.groupId, row.total]));
  return rows
    .map((row) => ({
      id: row.id,
      name: decryptGroupName(crypto, row),
      memberCount: memberCount.get(row.id) ?? 0,
      bankCount: bankCount.get(row.id) ?? 0,
    }))
    .sort(byName);
}

export async function listMembers(db: Database, crypto: CryptoService, groupId: string) {
  const rows = await db
    .select({
      id: users.id,
      nameEnc: users.nameEnc,
      emailEnc: users.emailEnc,
      active: users.active,
      addedAt: studyGroupMembers.addedAt,
    })
    .from(studyGroupMembers)
    .innerJoin(users, eq(users.id, studyGroupMembers.userId))
    .where(eq(studyGroupMembers.groupId, groupId));
  return rows
    .map((row) => ({
      id: row.id,
      name: decryptName(crypto, row),
      email: decryptEmail(crypto, row),
      active: row.active,
      addedAt: row.addedAt,
    }))
    .sort(byName);
}

/** Grupos (não excluídos) de que o usuário participa, por nome. */
export async function listGroupsOfUser(
  db: Database,
  crypto: CryptoService,
  userId: string,
): Promise<GroupSummary[]> {
  const rows = await db
    .select({ id: studyGroups.id, nameEnc: studyGroups.nameEnc })
    .from(studyGroupMembers)
    .innerJoin(studyGroups, eq(studyGroups.id, studyGroupMembers.groupId))
    .where(and(eq(studyGroupMembers.userId, userId), isNull(studyGroups.deletedAt)));
  return rows.map((row) => ({ id: row.id, name: decryptGroupName(crypto, row) })).sort(byName);
}

/** Adiciona só usuários comuns e ativos; quem já é membro é ignorado. Devolve quantos entraram. */
export async function addMembers(db: Database, groupId: string, userIds: string[]) {
  if (userIds.length === 0) return 0;
  const eligible = await db
    .select({ id: users.id })
    .from(users)
    .leftJoin(
      studyGroupMembers,
      and(eq(studyGroupMembers.userId, users.id), eq(studyGroupMembers.groupId, groupId)),
    )
    .where(
      and(
        inArray(users.id, userIds),
        eq(users.role, 'user'),
        eq(users.active, true),
        isNull(studyGroupMembers.userId),
      ),
    );
  if (eligible.length === 0) return 0;
  const now = new Date();
  await db
    .insert(studyGroupMembers)
    .values(eligible.map((row) => ({ groupId, userId: row.id, addedAt: now })));
  return eligible.length;
}

/**
 * Remove o membro. Os simulados dele saem deste grupo (continuam nos outros grupos dele), e ele
 * perde o acesso aos simulados do grupo que nunca fez.
 */
export async function removeMember(db: Database, groupId: string, userId: string) {
  await db.transaction(async (tx) => {
    await tx
      .delete(studyGroupMembers)
      .where(and(eq(studyGroupMembers.groupId, groupId), eq(studyGroupMembers.userId, userId)));
    await tx
      .delete(questionBankGroups)
      .where(
        and(
          eq(questionBankGroups.groupId, groupId),
          inArray(
            questionBankGroups.bankId,
            tx
              .select({ id: questionBanks.id })
              .from(questionBanks)
              .where(eq(questionBanks.userId, userId)),
          ),
        ),
      );
  });
}

/** Exclusão lógica. Os simulados saem do grupo; o que ficar sem nenhum grupo volta a ser privado. */
export async function deleteGroup(db: Database, groupId: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(studyGroups)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(studyGroups.id, groupId));
    await tx.delete(questionBankGroups).where(eq(questionBankGroups.groupId, groupId));
  });
}
