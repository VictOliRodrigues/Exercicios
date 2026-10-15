import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createFileStore } from './crypto/file-store.js';
import { createCryptoService } from './crypto/index.js';
import { createKeyring } from './crypto/keys.js';
import { createDatabase } from './db/client.js';

const env = loadEnv();
const crypto = createCryptoService(createKeyring(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION));
const { db, pool } = createDatabase(env.DATABASE_URL);
const fileStore = createFileStore(env.STORAGE_PATH, crypto);
await fileStore.ensureReady();

const MySQLStore = MySQLStoreFactory(session);
const sessionStore = new MySQLStore(
  {
    createDatabaseTable: true,
    clearExpired: true,
    checkExpirationInterval: 15 * 60_000,
    expiration: env.SESSION_IDLE_HOURS * 60 * 60_000,
  },
  // A v3 da biblioteca aceita o pool com promises (ela trata os dois estilos em query()),
  // mas os tipos ainda pedem o pool de callbacks.
  pool as unknown as ConstructorParameters<typeof MySQLStore>[1],
);

const app = createApp({ env, db, crypto, fileStore, sessionStore });
const server = app.listen(env.PORT, () => {
  console.log(`Simulados ouvindo na porta ${env.PORT} (${env.NODE_ENV})`);
});

function shutdown(signal: string) {
  console.log(`${signal} recebido, encerrando...`);
  server.close(async () => {
    await sessionStore.close();
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
