import path from 'node:path';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';

export function createDatabase(url: string) {
  const pool = mysql.createPool({ uri: url, connectionLimit: 10, timezone: 'Z' });
  const db = drizzle(pool, { schema, mode: 'default' });
  return { pool, db };
}

export type Database = ReturnType<typeof createDatabase>['db'];
export type Pool = ReturnType<typeof createDatabase>['pool'];

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: path.join(import.meta.dirname, 'migrations') });
}
