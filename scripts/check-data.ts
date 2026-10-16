import { eq } from 'drizzle-orm';
import { loadEnv } from '../src/config/env.js';
import { createFileStore } from '../src/crypto/file-store.js';
import { createCryptoService } from '../src/crypto/index.js';
import { createKeyring } from '../src/crypto/keys.js';
import { createDatabase } from '../src/db/client.js';
import { folders, questionBanks, questions, studyGroups, users } from '../src/db/schema.js';
import { decryptQuestion, decryptTitle } from '../src/modules/banks/banks.service.js';
import { decryptFolderName } from '../src/modules/folders/folders.service.js';
import { decryptGroupName } from '../src/modules/groups/groups.service.js';
import { decryptEmail, decryptName, decryptPhone } from '../src/modules/users/users.service.js';

// Confere se o banco, o volume e a ENCRYPTION_KEY combinam: decifra todos os campos e todos os
// arquivos. Serve para testar a restauração de um backup (Coolify → Terminal). Não mostra nenhum
// dado, só contagens e os ids do que falhou.

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL);
const crypto = createCryptoService(createKeyring(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION));
const fileStore = createFileStore(env.STORAGE_PATH, crypto);

const failures: string[] = [];

function check(label: string, id: string, read: () => unknown) {
  try {
    read();
  } catch {
    failures.push(`${label} ${id}`);
  }
}

try {
  const userRows = await db.select().from(users);
  for (const row of userRows) {
    check('usuário', row.id, () => [
      decryptName(crypto, row),
      decryptEmail(crypto, row),
      decryptPhone(crypto, row),
    ]);
  }

  const groupRows = await db.select().from(studyGroups);
  for (const row of groupRows) check('grupo', row.id, () => decryptGroupName(crypto, row));

  const folderRows = await db.select().from(folders);
  for (const row of folderRows) check('pasta', row.id, () => decryptFolderName(crypto, row));

  const bankRows = await db.select().from(questionBanks);
  let questionCount = 0;
  for (const bank of bankRows) {
    check('simulado', bank.id, () => [
      decryptTitle(crypto, bank),
      crypto.decryptField(bank.originalNameEnc, 'question_banks', 'original_name', bank.id),
    ]);
    try {
      await fileStore.read(bank.storageKey);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      failures.push(`arquivo ${bank.storageKey} (${missing ? 'não está no volume' : 'ilegível'})`);
    }
    const questionRows = await db
      .select({ id: questions.id, payloadEnc: questions.payloadEnc })
      .from(questions)
      .where(eq(questions.bankId, bank.id));
    questionCount += questionRows.length;
    for (const row of questionRows) check('questão', row.id, () => decryptQuestion(crypto, row));
  }

  console.log(
    `Conferidos: ${userRows.length} usuários, ${groupRows.length} grupos, ${folderRows.length} pastas, ` +
      `${bankRows.length} simulados (e seus arquivos) e ${questionCount} questões.`,
  );
  if (failures.length) {
    console.error(
      `${failures.length} falha(s). Confira se a ENCRYPTION_KEY e o volume são os do backup:`,
    );
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('Tudo legível com a ENCRYPTION_KEY atual.');
  }
} finally {
  await pool.end();
}
