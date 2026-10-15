import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { loadEnv } from '../src/config/env.js';
import { createCryptoService } from '../src/crypto/index.js';
import { createKeyring } from '../src/crypto/keys.js';
import { createDatabase } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { ADMIN_SEED_PASSWORD_MIN_LENGTH } from '../src/modules/auth/passwords.js';
import { createUser, findUserByEmail } from '../src/modules/users/users.service.js';

// Idempotente: só cria o admin se ainda não existir nenhum. Nunca altera a senha de quem já existe.

const seedSchema = z.object({
  email: z.email('ADMIN_EMAIL precisa ser um e-mail válido'),
  name: z.string().trim().min(1, 'ADMIN_NAME não pode ser vazio'),
  password: z
    .string('ADMIN_PASSWORD é obrigatória para criar o admin')
    .min(
      ADMIN_SEED_PASSWORD_MIN_LENGTH,
      `ADMIN_PASSWORD precisa ter pelo menos ${ADMIN_SEED_PASSWORD_MIN_LENGTH} caracteres`,
    ),
});

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL);
const crypto = createCryptoService(createKeyring(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION));

try {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1);

  if (existing) {
    console.log('Admin já existe. Nada a fazer.');
  } else {
    const parsed = seedSchema.safeParse({
      email: env.ADMIN_EMAIL,
      name: env.ADMIN_NAME ?? 'Administrador',
      password: env.ADMIN_PASSWORD,
    });
    if (!parsed.success) {
      console.error('Não foi possível criar o admin:');
      for (const issue of parsed.error.issues) console.error(`  - ${issue.message}`);
      process.exitCode = 1;
    } else if (await findUserByEmail(db, crypto, parsed.data.email)) {
      console.error('Não foi possível criar o admin: o ADMIN_EMAIL já pertence a outro usuário.');
      process.exitCode = 1;
    } else {
      await createUser(db, crypto, {
        ...parsed.data,
        role: 'admin',
        mustChangePassword: true,
      });
      console.log(
        `Admin criado (${parsed.data.email}). A troca de senha é obrigatória no primeiro login.`,
      );
    }
  }
} finally {
  await pool.end();
}
