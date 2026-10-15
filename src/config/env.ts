import { existsSync } from 'node:fs';
import { z } from 'zod';

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const encryptionKey = z
  .string({ error: 'é obrigatória' })
  .refine(
    (value) => BASE64_PATTERN.test(value) && Buffer.from(value, 'base64').length === 32,
    'precisa ter 32 bytes em base64 (gere com npm run keys:generate)',
  );

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  DATABASE_URL: z
    .string({ error: 'é obrigatória' })
    .startsWith('mysql://', 'precisa começar com mysql://'),
  SESSION_SECRET: z
    .string({ error: 'é obrigatória' })
    .min(32, 'precisa ter pelo menos 32 caracteres (gere com npm run keys:generate)'),
  SESSION_IDLE_HOURS: z.coerce.number().positive().default(8),
  COOKIE_SECURE: booleanString.optional(),
  ENCRYPTION_KEY: encryptionKey,
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).max(255).default(1),
  STORAGE_PATH: z.string().min(1).default('./storage'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(1),
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_NAME: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  LOGIN_MAX_FAILS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  FORGOT_MAX_PER_HOUR: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Variáveis de ambiente inválidas:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvError';
  }
}

/** Valida as variáveis. Valores vazios contam como ausentes. Nunca inclui valores na mensagem. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const filled = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = envSchema.safeParse(filled);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  return result.data;
}

export function isCookieSecure(env: Env): boolean {
  return env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
}

let cached: Env | undefined;

/** Lê o .env (se existir; variáveis já definidas no ambiente têm prioridade) e valida. */
export function loadEnv(): Env {
  if (cached) return cached;
  if (existsSync('.env')) process.loadEnvFile('.env');
  try {
    cached = parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  return cached;
}
