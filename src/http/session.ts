import type { NextFunction, Request, Response } from 'express';
import type { CryptoService } from '../crypto/index.js';
import type { Database } from '../db/client.js';
import { decryptName, findUserById, type Role } from '../modules/users/users.service.js';
import type { FlashMessage } from './types.js';

export const SESSION_COOKIE = 'simulados.sid';

export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.regenerate((error) => (error ? reject(error) : resolve())),
  );
}

export function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.destroy((error) => (error ? reject(error) : resolve())),
  );
}

export async function signIn(
  req: Request,
  user: { id: string; role: Role; sessionVersion: number },
): Promise<void> {
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.sessionVersion = user.sessionVersion;
}

export function flash(req: Request, type: FlashMessage['type'], message: string): void {
  (req.session.flash ??= []).push({ type, message });
}

export function homePathFor(role: Role): string {
  return role === 'admin' ? '/admin/usuarios' : '/';
}

/**
 * Carrega o usuário da sessão a cada requisição. Se ele foi desativado, ou se a versão da sessão
 * mudou (senha trocada ou redefinida), a sessão é descartada.
 */
export function loadCurrentUser(db: Database, crypto: CryptoService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    res.locals.currentUser = null;
    const { userId, sessionVersion } = req.session;
    if (!userId) return next();

    const row = await findUserById(db, userId);
    if (!row || !row.active || row.sessionVersion !== sessionVersion) {
      await regenerateSession(req);
      return next();
    }

    req.currentUser = {
      id: row.id,
      role: row.role,
      name: decryptName(crypto, row),
      mustChangePassword: row.mustChangePassword,
    };
    res.locals.currentUser = req.currentUser;
    next();
  };
}

export function exposeFlash(req: Request, res: Response, next: NextFunction) {
  res.locals.flash = req.session.flash ?? [];
  delete req.session.flash;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.currentUser) return res.redirect('/login');
  next();
}

export function enforcePasswordChange(req: Request, res: Response, next: NextFunction) {
  if (req.currentUser?.mustChangePassword) return res.redirect('/alterar-senha');
  next();
}

/** Perfil errado recebe 404, para não revelar quais rotas existem. */
export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.currentUser?.role !== role) return renderNotFound(req, res);
    next();
  };
}

export function renderNotFound(_req: Request, res: Response) {
  res.status(404).render('errors/404', { title: 'Página não encontrada' });
}

export const userOnly = [requireAuth, enforcePasswordChange, requireRole('user')];
export const adminOnly = [requireAuth, enforcePasswordChange, requireRole('admin')];
