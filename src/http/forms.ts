import type { Request } from 'express';
import { z } from 'zod';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value);

/** Valor digitado, para devolver ao formulário quando a validação falha. */
export function textField(req: Request, name: string, max: number): string {
  const value: unknown = req.body?.[name];
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Caixas de seleção com o mesmo nome chegam como texto (uma) ou lista (várias). Só ids válidos. */
export function idListField(req: Request, name: string): string[] {
  const value: unknown = req.body?.[name];
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter(isUuid))];
}

export const issueMessages = (error: z.ZodError) => error.issues.map((issue) => issue.message);

/** Junta espaços repetidos e tira os das pontas. */
export const singleLine = (value: string) => value.replace(/\s+/g, ' ').trim();
