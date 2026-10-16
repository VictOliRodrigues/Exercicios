import { eq, sql } from 'drizzle-orm';
import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { users } from '../../db/schema.js';
import { textField } from '../../http/forms.js';
import {
  destroySession,
  flash,
  homePathFor,
  requireAuth,
  signIn,
  SESSION_COOKIE,
} from '../../http/session.js';
import { findUserByEmail, findUserById, setPassword } from '../users/users.service.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  spendPasswordCheck,
  verifyPassword,
} from './passwords.js';

const INVALID_LOGIN =
  'E-mail ou senha inválidos. Depois de várias tentativas erradas, o acesso fica bloqueado por alguns minutos.';

const loginSchema = z.object({
  email: z.string().trim().min(1).max(254),
  senha: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

const forgotSchema = z.object({
  email: z.email().max(254),
});

const changePasswordSchema = z
  .object({
    senhaAtual: z.string().min(1, 'Informe a senha atual.').max(PASSWORD_MAX_LENGTH),
    novaSenha: z
      .string()
      .min(
        PASSWORD_MIN_LENGTH,
        `A nova senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`,
      )
      .max(
        PASSWORD_MAX_LENGTH,
        `A nova senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`,
      ),
    confirmacao: z.string(),
  })
  .refine((data) => data.novaSenha === data.confirmacao, {
    message: 'A confirmação não confere com a nova senha.',
    path: ['confirmacao'],
  });

export function authRoutes({ db, crypto, env }: AppDeps): Router {
  const router = Router();

  const renderLogin = (res: Response, status: number, email: string, error: string | null) =>
    res.status(status).render('auth/login', { title: 'Entrar', email, error });

  const renderForgot = (
    res: Response,
    status: number,
    view: { email?: string; error?: string | null; sent?: boolean },
  ) =>
    res.status(status).render('auth/esqueci-senha', {
      title: 'Esqueci minha senha',
      email: view.email ?? '',
      error: view.error ?? null,
      sent: view.sent ?? false,
    });

  // Conta só as tentativas que falham: um grupo de estudo na mesma rede (mesmo IP) pode fazer
  // muitos logins certos em poucos minutos.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 30,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) =>
      renderLogin(
        res,
        429,
        textField(req, 'email', 254),
        'Muitas tentativas a partir desta rede. Aguarde alguns minutos e tente de novo.',
      ),
  });

  const forgotLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: env.FORGOT_MAX_PER_HOUR,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) =>
      renderForgot(res, 429, { error: 'Muitos pedidos a partir desta rede. Tente mais tarde.' }),
  });

  // Com a sessão de outra pessoa nas mãos, não dá para testar a senha atual à vontade.
  const changePasswordLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => req.currentUser!.id,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).render('auth/alterar-senha', {
        title: 'Alterar senha',
        errors: ['Muitas tentativas. Aguarde alguns minutos e tente de novo.'],
        forced: req.currentUser!.mustChangePassword,
      }),
  });

  /**
   * Conta a tentativa antes de conferir a senha, numa única instrução no banco. A tentativa que
   * completa o limite já bloqueia a conta (e um login certo nela desbloqueia). Assim, pedidos
   * simultâneos não passam do limite. Devolve false se a conta está bloqueada.
   */
  async function reserveLoginAttempt(userId: string, now: Date): Promise<boolean> {
    const lockUntil = new Date(now.getTime() + env.LOGIN_LOCK_MINUTES * 60_000);
    const reachesLimit = sql`${users.failedLogins} + 1 >= ${env.LOGIN_MAX_FAILS}`;
    // O MySQL aplica as atribuições da esquerda para a direita: locked_until vem antes para ainda
    // ver a contagem antiga.
    const [result] = await db.execute(sql`
      update ${users}
      set ${users.lockedUntil} = if(${reachesLimit}, ${lockUntil}, ${users.lockedUntil}),
          ${users.failedLogins} = if(${reachesLimit}, 0, ${users.failedLogins} + 1)
      where ${users.id} = ${userId}
        and (${users.lockedUntil} is null or ${users.lockedUntil} <= ${now})
    `);
    return result.affectedRows > 0;
  }

  router.get('/login', (req, res) => {
    if (req.currentUser) return res.redirect(homePathFor(req.currentUser.role));
    renderLogin(res, 200, '', null);
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const typedEmail = textField(req, 'email', 254);
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return renderLogin(res, 401, typedEmail, INVALID_LOGIN);

    const { email, senha } = parsed.data;
    const now = new Date();
    const user = await findUserByEmail(db, crypto, email);

    if (!user || !(await reserveLoginAttempt(user.id, now))) {
      await spendPasswordCheck(senha);
      return renderLogin(res, 401, typedEmail, INVALID_LOGIN);
    }
    if (!(await verifyPassword(user.passwordHash, senha)) || !user.active) {
      return renderLogin(res, 401, typedEmail, INVALID_LOGIN);
    }

    await db
      .update(users)
      .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: now })
      .where(eq(users.id, user.id));
    await signIn(req, user);
    res.redirect(user.mustChangePassword ? '/alterar-senha' : homePathFor(user.role));
  });

  router.post('/logout', async (req, res) => {
    await destroySession(req);
    res.clearCookie(SESSION_COOKIE);
    res.redirect('/login');
  });

  router.get('/esqueci-senha', (req, res) => {
    if (req.currentUser) return res.redirect(homePathFor(req.currentUser.role));
    renderForgot(res, 200, {});
  });

  router.post('/esqueci-senha', forgotLimiter, async (req, res) => {
    const typedEmail = textField(req, 'email', 254);
    const parsed = forgotSchema.safeParse({ email: typedEmail });
    if (!parsed.success) {
      return renderForgot(res, 422, { email: typedEmail, error: 'Informe um e-mail válido.' });
    }

    // A resposta é sempre a mesma, exista o e-mail ou não. Pedido do admin não é registrado:
    // ele usa o comando admin:reset-password no servidor.
    const user = await findUserByEmail(db, crypto, parsed.data.email);
    if (user && user.active && user.role === 'user' && !user.passwordResetRequestedAt) {
      await db
        .update(users)
        .set({ passwordResetRequestedAt: new Date() })
        .where(eq(users.id, user.id));
    }
    renderForgot(res, 200, { sent: true });
  });

  router.get('/alterar-senha', requireAuth, (req, res) => {
    res.render('auth/alterar-senha', {
      title: 'Alterar senha',
      errors: [],
      forced: req.currentUser!.mustChangePassword,
    });
  });

  router.post('/alterar-senha', requireAuth, changePasswordLimiter, async (req, res) => {
    const current = req.currentUser!;
    const renderErrors = (errors: string[]) =>
      res.status(422).render('auth/alterar-senha', {
        title: 'Alterar senha',
        errors,
        forced: current.mustChangePassword,
      });

    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) return renderErrors(parsed.error.issues.map((issue) => issue.message));

    const { senhaAtual, novaSenha } = parsed.data;
    const row = await findUserById(db, current.id);
    if (!row || !(await verifyPassword(row.passwordHash, senhaAtual))) {
      return renderErrors(['A senha atual está incorreta.']);
    }
    if (novaSenha === senhaAtual) {
      return renderErrors(['A nova senha precisa ser diferente da atual.']);
    }

    const sessionVersion = await setPassword(db, row.id, novaSenha, {
      mustChangePassword: false,
    });
    await signIn(req, { id: row.id, role: row.role, sessionVersion });
    flash(req, 'success', 'Senha alterada com sucesso.');
    res.redirect(homePathFor(row.role));
  });

  return router;
}
