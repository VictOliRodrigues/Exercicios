import { loadEnv } from '../src/config/env.js';
import { createDatabase, runMigrations } from '../src/db/client.js';

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL);

try {
  await runMigrations(db);
  console.log('Migrations aplicadas.');
} finally {
  await pool.end();
}
