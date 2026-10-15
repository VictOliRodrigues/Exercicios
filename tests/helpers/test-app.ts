import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import session from 'express-session';
import mysql from 'mysql2/promise';
import type { Agent } from 'supertest';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { createFileStore } from '../../src/crypto/file-store.js';
import { createCryptoService } from '../../src/crypto/index.js';
import { createKeyring } from '../../src/crypto/keys.js';
import { createDatabase, runMigrations, type Pool } from '../../src/db/client.js';

const TABLES = [
  'attempt_questions',
  'attempts',
  'questions',
  'question_bank_groups',
  'question_banks',
  'study_group_members',
  'study_groups',
  'users',
];

function testDatabaseUrl(): string {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Defina TEST_DATABASE_URL no .env para rodar os testes de integração');
  return url;
}

async function ensureDatabaseExists(url: string) {
  const parsed = new URL(url);
  const name = parsed.pathname.slice(1);
  // Os testes apagam tudo entre um caso e outro: nunca rodar contra um banco que não seja de teste.
  if (!/^\w+_test$/.test(name)) throw new Error('O banco de teste precisa terminar com _test');
  parsed.pathname = '/';
  const connection = await mysql.createConnection(parsed.toString());
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${name}\``);
  await connection.end();
}

export async function resetTables(pool: Pool) {
  const connection = await pool.getConnection();
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of TABLES) await connection.query(`TRUNCATE TABLE \`${table}\``);
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    connection.release();
  }
}

export async function buildTestApp(overrides: Record<string, string> = {}) {
  const url = testDatabaseUrl();
  await ensureDatabaseExists(url);
  const { db, pool } = createDatabase(url);
  await runMigrations(db);

  const env = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    SESSION_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    STORAGE_PATH: await mkdtemp(path.join(tmpdir(), 'simulados-')),
    ...overrides,
  });
  const crypto = createCryptoService(createKeyring(env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_VERSION));
  const fileStore = createFileStore(env.STORAGE_PATH, crypto);
  await fileStore.ensureReady();
  const app = createApp({ env, db, crypto, fileStore, sessionStore: new session.MemoryStore() });

  return { app, db, pool, crypto, env, close: () => pool.end() };
}

/** Abre a página e devolve o token CSRF do formulário. */
export async function csrfFrom(agent: Agent, pagePath: string): Promise<string> {
  const res = await agent.get(pagePath);
  const match = /name="_csrf" value="([^"]+)"/.exec(res.text);
  if (!match) throw new Error(`Nenhum token CSRF em ${pagePath} (status ${res.status})`);
  return match[1]!;
}

export async function login(agent: Agent, email: string, senha: string) {
  const _csrf = await csrfFrom(agent, '/login');
  return agent.post('/login').type('form').send({ _csrf, email, senha });
}
