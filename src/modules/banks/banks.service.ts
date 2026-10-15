import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { CryptoService } from '../../crypto/index.js';
import type { FileStore } from '../../crypto/file-store.js';
import type { Database } from '../../db/client.js';
import {
  attempts,
  questionBankGroups,
  questionBanks,
  questions,
  studyGroupMembers,
  studyGroups,
  users,
} from '../../db/schema.js';
import type { ParsedQuestion } from '../../markdown/parse-questions.js';
import { decryptGroupName, type GroupSummary } from '../groups/groups.service.js';
import { decryptName } from '../users/users.service.js';

export type BankRow = typeof questionBanks.$inferSelect;

/** Conteúdo de cada questão, gravado criptografado em questions.payload_enc. */
export interface QuestionPayload {
  statementHtml: string;
  options: string[];
  correct: number;
  sourceLine: number | null;
}

const INSERT_BATCH = 200;

export function decryptTitle(crypto: CryptoService, bank: Pick<BankRow, 'id' | 'titleEnc'>) {
  return crypto.decryptField(bank.titleEnc, 'question_banks', 'title', bank.id);
}

export interface ImportInput {
  ownerId: string;
  title: string;
  originalName: string;
  content: Buffer;
  questions: ParsedQuestion[];
  groupIds: string[];
}

/**
 * Grava o arquivo original criptografado e, numa única transação, o simulado, o compartilhamento
 * e as questões. Se a transação falhar, o arquivo é apagado.
 */
export async function importBank(
  db: Database,
  crypto: CryptoService,
  fileStore: FileStore,
  input: ImportInput,
): Promise<string> {
  const storageKey = await fileStore.save(input.content);
  const bankId = uuidv7();
  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(questionBanks).values({
        id: bankId,
        userId: input.ownerId,
        titleEnc: crypto.encryptField(input.title, 'question_banks', 'title', bankId),
        originalNameEnc: crypto.encryptField(
          input.originalName,
          'question_banks',
          'original_name',
          bankId,
        ),
        storageKey,
        questionCount: input.questions.length,
        createdAt: now,
        updatedAt: now,
      });
      if (input.groupIds.length) {
        await tx
          .insert(questionBankGroups)
          .values(input.groupIds.map((groupId) => ({ bankId, groupId, sharedAt: now })));
      }
      const rows = input.questions.map((question) => {
        const id = uuidv7();
        const payload: QuestionPayload = {
          statementHtml: question.statementHtml,
          options: question.optionsHtml,
          correct: question.correct,
          sourceLine: question.sourceLine,
        };
        return {
          id,
          bankId,
          position: question.position,
          payloadEnc: crypto.encryptField(JSON.stringify(payload), 'questions', 'payload', id),
        };
      });
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        await tx.insert(questions).values(rows.slice(i, i + INSERT_BATCH));
      }
    });
  } catch (error) {
    await fileStore.remove(storageKey).catch(() => undefined);
    throw error;
  }
  return bankId;
}

/** Grupos não excluídos dos quais o usuário é membro e com os quais o simulado está compartilhado. */
function groupsGivingAccess(db: Database, userId: string, bankId: string) {
  return db
    .select({ id: studyGroups.id, nameEnc: studyGroups.nameEnc })
    .from(questionBankGroups)
    .innerJoin(studyGroups, eq(studyGroups.id, questionBankGroups.groupId))
    .innerJoin(
      studyGroupMembers,
      and(eq(studyGroupMembers.groupId, studyGroups.id), eq(studyGroupMembers.userId, userId)),
    )
    .where(and(eq(questionBankGroups.bankId, bankId), isNull(studyGroups.deletedAt)));
}

export interface BankAccess {
  bank: BankRow;
  isOwner: boolean;
  /** Grupos do usuário pelos quais ele vê o simulado de outra pessoa. */
  viaGroups: GroupSummary[];
  /** Tem pelo menos uma tentativa: fica com o simulado mesmo que o compartilhamento acabe. */
  hasAttempts: boolean;
}

/**
 * A única função de permissão para abrir um simulado (seção 7 do plano):
 * 1. o dono, se o simulado não estiver excluído;
 * 2. um membro de um dos grupos com que ele está compartilhado, se o simulado e o grupo não
 *    estiverem excluídos;
 * 3. qualquer outra pessoa com pelo menos uma tentativa, mesmo que o dono tenha excluído.
 * Sem acesso, devolve null (a rota responde 404).
 */
export async function findBankAccess(
  db: Database,
  crypto: CryptoService,
  userId: string,
  bankId: string,
): Promise<BankAccess | null> {
  const [bank] = await db.select().from(questionBanks).where(eq(questionBanks.id, bankId)).limit(1);
  if (!bank) return null;

  if (bank.userId === userId) {
    return bank.deletedAt ? null : { bank, isOwner: true, viaGroups: [], hasAttempts: false };
  }

  const viaGroups = bank.deletedAt
    ? []
    : (await groupsGivingAccess(db, userId, bankId)).map((row) => ({
        id: row.id,
        name: decryptGroupName(crypto, row),
      }));
  const [attempt] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.userId, userId), eq(attempts.bankId, bankId)))
    .limit(1);
  if (viaGroups.length === 0 && !attempt) return null;
  return { bank, isOwner: false, viaGroups, hasAttempts: Boolean(attempt) };
}

/** Grupos (não excluídos) com que o simulado está compartilhado, por nome. */
export async function listSharedGroups(
  db: Database,
  crypto: CryptoService,
  bankId: string,
): Promise<GroupSummary[]> {
  const rows = await db
    .select({ id: studyGroups.id, nameEnc: studyGroups.nameEnc })
    .from(questionBankGroups)
    .innerJoin(studyGroups, eq(studyGroups.id, questionBankGroups.groupId))
    .where(and(eq(questionBankGroups.bankId, bankId), isNull(studyGroups.deletedAt)));
  return rows
    .map((row) => ({ id: row.id, name: decryptGroupName(crypto, row) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/** Troca o compartilhamento. Nenhum grupo = privado. Quem já tinha o grupo mantém a data original. */
export async function setBankGroups(db: Database, bankId: string, groupIds: string[]) {
  const now = new Date();
  await db.transaction(async (tx) => {
    const current = await tx
      .select({ groupId: questionBankGroups.groupId })
      .from(questionBankGroups)
      .where(eq(questionBankGroups.bankId, bankId));
    const currentIds = new Set(current.map((row) => row.groupId));
    const toRemove = [...currentIds].filter((id) => !groupIds.includes(id));
    const toAdd = groupIds.filter((id) => !currentIds.has(id));
    if (toRemove.length) {
      await tx
        .delete(questionBankGroups)
        .where(
          and(eq(questionBankGroups.bankId, bankId), inArray(questionBankGroups.groupId, toRemove)),
        );
    }
    if (toAdd.length) {
      await tx
        .insert(questionBankGroups)
        .values(toAdd.map((groupId) => ({ bankId, groupId, sharedAt: now })));
    }
  });
}

/** Exclusão lógica: some para o dono e para quem nunca fez; quem já fez continua com ele. */
export async function deleteBank(db: Database, bankId: string) {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(questionBanks)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(questionBanks.id, bankId));
    await tx.delete(questionBankGroups).where(eq(questionBankGroups.bankId, bankId));
  });
}

export interface BankCard {
  id: string;
  title: string;
  questionCount: number;
  createdAt: Date;
  /** Para os próprios: grupos com que está compartilhado. */
  sharedWith: string[];
  /** Para os dos outros: quem enviou. */
  ownerName: string | null;
}

export interface Panel {
  mine: BankCard[];
  received: BankCard[];
  groups: (GroupSummary & { banks: BankCard[] })[];
}

/**
 * Painel do usuário (seção 5.7): os próprios simulados, os recebidos (feitos, mas que não estão
 * mais em nenhum grupo dele) e uma seção para cada grupo com os simulados dos outros membros.
 */
export async function loadPanel(
  db: Database,
  crypto: CryptoService,
  userId: string,
  myGroups: GroupSummary[],
): Promise<Panel> {
  const ownerNames = new Map<string, string>();
  const ownerName = (row: { ownerId: string; ownerNameEnc: string }) => {
    let name = ownerNames.get(row.ownerId);
    if (name === undefined) {
      name = decryptName(crypto, { id: row.ownerId, nameEnc: row.ownerNameEnc });
      ownerNames.set(row.ownerId, name);
    }
    return name;
  };
  const card = (bank: BankRow, extra: Partial<BankCard> = {}): BankCard => ({
    id: bank.id,
    title: decryptTitle(crypto, bank),
    questionCount: bank.questionCount,
    createdAt: bank.createdAt,
    sharedWith: [],
    ownerName: null,
    ...extra,
  });

  const owned = await db
    .select()
    .from(questionBanks)
    .where(and(eq(questionBanks.userId, userId), isNull(questionBanks.deletedAt)))
    .orderBy(desc(questionBanks.createdAt));
  const sharing = owned.length
    ? await db
        .select({
          bankId: questionBankGroups.bankId,
          id: studyGroups.id,
          nameEnc: studyGroups.nameEnc,
        })
        .from(questionBankGroups)
        .innerJoin(studyGroups, eq(studyGroups.id, questionBankGroups.groupId))
        .where(
          and(
            inArray(
              questionBankGroups.bankId,
              owned.map((bank) => bank.id),
            ),
            isNull(studyGroups.deletedAt),
          ),
        )
    : [];
  const sharedWith = new Map<string, string[]>();
  for (const row of sharing) {
    sharedWith.set(row.bankId, [
      ...(sharedWith.get(row.bankId) ?? []),
      decryptGroupName(crypto, row),
    ]);
  }
  const mine = owned.map((bank) =>
    card(bank, {
      sharedWith: (sharedWith.get(bank.id) ?? []).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    }),
  );

  // Recebidos: tem tentativa, não é o dono e não chega mais por nenhum grupo.
  const stillShared = db
    .select({ one: sql`1` })
    .from(questionBankGroups)
    .innerJoin(studyGroups, eq(studyGroups.id, questionBankGroups.groupId))
    .innerJoin(
      studyGroupMembers,
      and(eq(studyGroupMembers.groupId, studyGroups.id), eq(studyGroupMembers.userId, userId)),
    )
    .where(and(eq(questionBankGroups.bankId, questionBanks.id), isNull(studyGroups.deletedAt)));
  const receivedRows = await db
    .selectDistinct({ bank: questionBanks, ownerId: users.id, ownerNameEnc: users.nameEnc })
    .from(attempts)
    .innerJoin(questionBanks, eq(questionBanks.id, attempts.bankId))
    .innerJoin(users, eq(users.id, questionBanks.userId))
    .where(
      and(
        eq(attempts.userId, userId),
        ne(questionBanks.userId, userId),
        or(isNotNull(questionBanks.deletedAt), sql`not exists (${stillShared})`),
      ),
    )
    .orderBy(desc(questionBanks.createdAt));
  const received = receivedRows.map((row) => card(row.bank, { ownerName: ownerName(row) }));

  const groupRows = myGroups.length
    ? await db
        .select({
          groupId: questionBankGroups.groupId,
          bank: questionBanks,
          ownerId: users.id,
          ownerNameEnc: users.nameEnc,
        })
        .from(questionBankGroups)
        .innerJoin(questionBanks, eq(questionBanks.id, questionBankGroups.bankId))
        .innerJoin(users, eq(users.id, questionBanks.userId))
        .where(
          and(
            inArray(
              questionBankGroups.groupId,
              myGroups.map((group) => group.id),
            ),
            isNull(questionBanks.deletedAt),
            ne(questionBanks.userId, userId),
          ),
        )
        .orderBy(desc(questionBanks.createdAt))
    : [];
  const groups = myGroups.map((group) => ({
    ...group,
    banks: groupRows
      .filter((row) => row.groupId === group.id)
      .map((row) => card(row.bank, { ownerName: ownerName(row) })),
  }));

  return { mine, received, groups };
}

export async function findOwnerName(db: Database, crypto: CryptoService, ownerId: string) {
  const [owner] = await db
    .select({ id: users.id, nameEnc: users.nameEnc })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  return owner ? decryptName(crypto, owner) : '';
}
