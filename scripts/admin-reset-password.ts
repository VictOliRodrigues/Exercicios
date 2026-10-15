import { eq } from 'drizzle-orm';
import { loadEnv } from '../src/config/env.js';
import { createCryptoService } from '../src/crypto/index.js';
import { createKeyring } from '../src/crypto/keys.js';
import { createDatabase } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { generateTemporaryPassword } from '../src/modules/auth/passwords.js';
import { decryptEmail, setPassword } from '../src/modules/users/users.service.js';

// Para quando o admin esquece a própria senha: roda no terminal do container (Coolify → Terminal).

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL);
const crypto = createCryptoService(createKeyring(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION));

try {
  const [admin] = await db.select().from(users).where(eq(users.role, 'admin')).limit(1);
  if (!admin) {
    console.error('Nenhum admin encontrado. Rode o seed primeiro.');
    process.exitCode = 1;
  } else {
    const password = generateTemporaryPassword();
    await setPassword(db, admin.id, password, { mustChangePassword: true });
    console.log(`Senha temporária do admin (${decryptEmail(crypto, admin)}): ${password}`);
    console.log('Ela precisa ser trocada no próximo login. As sessões abertas foram encerradas.');
  }
} finally {
  await pool.end();
}
