import { and, eq, inArray } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { CryptoService } from '../../crypto/index.js';
import type { Database } from '../../db/client.js';
import { folderBanks, folders } from '../../db/schema.js';

export const FOLDER_NAME_MAX_LENGTH = 80;

export type FolderRow = typeof folders.$inferSelect;

export interface FolderSummary {
  id: string;
  name: string;
}

export function decryptFolderName(crypto: CryptoService, row: { id: string; nameEnc: string }) {
  return crypto.decryptField(row.nameEnc, 'folders', 'name', row.id);
}

const compareNames = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' });

/** Pastas do usuário, por nome. */
export async function listFolders(
  db: Database,
  crypto: CryptoService,
  userId: string,
): Promise<FolderSummary[]> {
  const rows = await db.select().from(folders).where(eq(folders.userId, userId));
  return rows
    .map((row) => ({ id: row.id, name: decryptFolderName(crypto, row) }))
    .sort((a, b) => compareNames(a.name, b.name));
}

/** Pasta do próprio usuário. A de outra pessoa não é encontrada (a rota responde 404). */
export async function findFolder(db: Database, userId: string, folderId: string) {
  const [row] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.userId, userId)))
    .limit(1);
  return row;
}

/** Os nomes estão criptografados: a comparação (sem maiúsculas nem acentos) é feita aqui. */
export async function isFolderNameTaken(
  db: Database,
  crypto: CryptoService,
  userId: string,
  name: string,
  exceptFolderId?: string,
): Promise<boolean> {
  return (await listFolders(db, crypto, userId)).some(
    (folder) => folder.id !== exceptFolderId && compareNames(folder.name, name) === 0,
  );
}

/** Pasta em que o usuário guardou o simulado, se houver. */
export async function findBankFolder(
  db: Database,
  crypto: CryptoService,
  userId: string,
  bankId: string,
): Promise<FolderSummary | null> {
  const [row] = await db
    .select({ id: folders.id, nameEnc: folders.nameEnc })
    .from(folderBanks)
    .innerJoin(folders, eq(folders.id, folderBanks.folderId))
    .where(and(eq(folderBanks.userId, userId), eq(folderBanks.bankId, bankId)))
    .limit(1);
  return row ? { id: row.id, name: decryptFolderName(crypto, row) } : null;
}

type Executor = Pick<Database, 'insert'>;

/** Guarda os simulados na pasta. O que estava em outra pasta muda para esta. */
async function placeBanks(
  db: Executor,
  userId: string,
  folderId: string,
  bankIds: string[],
): Promise<void> {
  if (!bankIds.length) return;
  const addedAt = new Date();
  await db
    .insert(folderBanks)
    .values(bankIds.map((bankId) => ({ userId, bankId, folderId, addedAt })))
    .onDuplicateKeyUpdate({ set: { folderId, addedAt } });
}

export async function createFolder(
  db: Database,
  crypto: CryptoService,
  userId: string,
  name: string,
  bankIds: string[] = [],
): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(folders).values({
      id,
      userId,
      nameEnc: crypto.encryptField(name, 'folders', 'name', id),
      createdAt: now,
      updatedAt: now,
    });
    await placeBanks(tx, userId, id, bankIds);
  });
  return id;
}

export async function renameFolder(
  db: Database,
  crypto: CryptoService,
  folderId: string,
  name: string,
) {
  await db
    .update(folders)
    .set({ nameEnc: crypto.encryptField(name, 'folders', 'name', folderId), updatedAt: new Date() })
    .where(eq(folders.id, folderId));
}

/** A pasta é apagada; os simulados dela voltam para Meus simulados, sem pasta. */
export async function deleteFolder(db: Database, folderId: string) {
  await db.delete(folders).where(eq(folders.id, folderId));
}

export function moveBanksToFolder(
  db: Database,
  userId: string,
  folderId: string,
  bankIds: string[],
) {
  return placeBanks(db, userId, folderId, bankIds);
}

/** Tira os simulados de qualquer pasta do usuário. */
export async function removeBanksFromFolders(db: Database, userId: string, bankIds: string[]) {
  if (!bankIds.length) return;
  await db
    .delete(folderBanks)
    .where(and(eq(folderBanks.userId, userId), inArray(folderBanks.bankId, bankIds)));
}

/** bankId → id da pasta, para todos os simulados que o usuário guardou numa pasta. */
export async function loadPlacements(db: Database, userId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({ bankId: folderBanks.bankId, folderId: folderBanks.folderId })
    .from(folderBanks)
    .where(eq(folderBanks.userId, userId));
  return new Map(rows.map((row) => [row.bankId, row.folderId]));
}
