import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import type { UserRow } from '../../db/schema.js';
import { digitsOnly, formatPhone } from '../../http/format.js';
import { isUuid, issueMessages, singleLine, textField } from '../../http/forms.js';
import { adminOnly, flash, renderNotFound } from '../../http/session.js';
import {
  generateTemporaryPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../auth/passwords.js';
import {
  createUser,
  decryptEmail,
  decryptName,
  decryptPhone,
  findManagedUser,
  isEmailTaken,
  listManagedUsers,
  setPassword,
  setUserActive,
  updateUserProfile,
} from '../users/users.service.js';

const NAME_MAX_LENGTH = 120;

const profileSchema = z.object({
  nome: z
    .string({ error: 'Informe o nome completo.' })
    .transform(singleLine)
    .pipe(
      z
        .string()
        .min(3, 'Informe o nome completo.')
        .max(NAME_MAX_LENGTH, `O nome pode ter no máximo ${NAME_MAX_LENGTH} caracteres.`),
    ),
  email: z
    .string({ error: 'Informe o e-mail.' })
    .trim()
    .max(254, 'O e-mail pode ter no máximo 254 caracteres.')
    .pipe(z.email('Informe um e-mail válido.')),
  telefone: z
    .string({ error: 'Informe o telefone com DDD.' })
    .transform(digitsOnly)
    .refine(
      (digits) => digits.length === 10 || digits.length === 11,
      'Informe o telefone com DDD (10 ou 11 dígitos).',
    ),
});

const passwordSchema = z
  .string({ error: 'Digite a senha ou use o botão de gerar.' })
  .min(PASSWORD_MIN_LENGTH, `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`)
  .max(PASSWORD_MAX_LENGTH, `A senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`);

type ProfileForm = { nome: string; email: string; telefone: string };

const emptyForm: ProfileForm = { nome: '', email: '', telefone: '' };

const formValues = (req: Request): ProfileForm => ({
  nome: textField(req, 'nome', NAME_MAX_LENGTH),
  email: textField(req, 'email', 254),
  telefone: textField(req, 'telefone', 30),
});

/** Senha digitada ou gerada pelo servidor (botão com name="acao" value="gerar"). */
function chosenPassword(req: Request) {
  if (req.body?.acao === 'gerar') {
    return { ok: true as const, password: generateTemporaryPassword(), generated: true };
  }
  const parsed = passwordSchema.safeParse(req.body?.senha);
  if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]!.message };
  return { ok: true as const, password: parsed.data, generated: false };
}

export function adminUsersRoutes({ db, crypto }: AppDeps): Router {
  const router = Router();
  router.use(...adminOnly);

  const managedUser = (req: Request) =>
    isUuid(req.params.id) ? findManagedUser(db, req.params.id) : Promise.resolve(undefined);

  async function renderList(
    res: Response,
    status: number,
    view: { form: ProfileForm; errors: string[] } = { form: emptyForm, errors: [] },
  ) {
    res.status(status).render('admin/usuarios', {
      title: 'Usuários',
      users: await listManagedUsers(db, crypto),
      ...view,
    });
  }

  /** A senha gerada aparece uma única vez, na resposta do próprio POST; nunca vai para a sessão. */
  function renderGeneratedPassword(
    res: Response,
    view: { heading: string; name: string; email: string; password: string },
  ) {
    res.render('admin/senha-gerada', { title: view.heading, ...view });
  }

  router.get('/usuarios', async (_req, res) => {
    await renderList(res, 200);
  });

  router.post('/usuarios', async (req, res) => {
    const form = formValues(req);
    const parsed = profileSchema.safeParse(req.body);
    const password = chosenPassword(req);
    const errors = [
      ...(parsed.success ? [] : issueMessages(parsed.error)),
      ...(password.ok ? [] : [password.error]),
    ];
    if (parsed.success && (await isEmailTaken(db, crypto, parsed.data.email))) {
      errors.push('Este e-mail já é usado por outro usuário.');
    }
    if (errors.length || !parsed.success || !password.ok) {
      return renderList(res, 422, { form, errors });
    }

    const { nome, email, telefone } = parsed.data;
    await createUser(db, crypto, {
      name: nome,
      email,
      phone: telefone,
      password: password.password,
      role: 'user',
      mustChangePassword: true,
    });
    if (password.generated) {
      return renderGeneratedPassword(res, {
        heading: 'Cadastro criado',
        name: nome,
        email,
        password: password.password,
      });
    }
    flash(
      req,
      'success',
      `Cadastro de ${nome} criado. Envie o e-mail e a senha inicial por fora do sistema.`,
    );
    res.redirect('/admin/usuarios');
  });

  router.get('/usuarios/:id', async (req, res) => {
    const user = await managedUser(req);
    if (!user) return renderNotFound(req, res);
    res.render('admin/usuario-editar', {
      title: 'Editar usuário',
      userId: user.id,
      form: {
        nome: decryptName(crypto, user),
        email: decryptEmail(crypto, user),
        telefone: formatPhone(decryptPhone(crypto, user)),
      },
      errors: [],
    });
  });

  router.post('/usuarios/:id', async (req, res) => {
    const user = await managedUser(req);
    if (!user) return renderNotFound(req, res);

    const parsed = profileSchema.safeParse(req.body);
    const errors = parsed.success ? [] : issueMessages(parsed.error);
    if (parsed.success && (await isEmailTaken(db, crypto, parsed.data.email, user.id))) {
      errors.push('Este e-mail já é usado por outro usuário.');
    }
    if (errors.length || !parsed.success) {
      return res.status(422).render('admin/usuario-editar', {
        title: 'Editar usuário',
        userId: user.id,
        form: formValues(req),
        errors,
      });
    }

    const { nome, email, telefone } = parsed.data;
    await updateUserProfile(db, crypto, user.id, { name: nome, email, phone: telefone });
    flash(req, 'success', `Dados de ${nome} atualizados.`);
    res.redirect('/admin/usuarios');
  });

  router.post('/usuarios/:id/ativo', async (req, res) => {
    const user = await managedUser(req);
    if (!user) return renderNotFound(req, res);
    const active = req.body?.ativo === 'true';
    await setUserActive(db, user.id, active);
    const name = decryptName(crypto, user);
    flash(
      req,
      'success',
      active
        ? `Acesso de ${name} reativado.`
        : `Acesso de ${name} desativado. As sessões abertas foram encerradas.`,
    );
    res.redirect('/admin/usuarios');
  });

  const renderResetForm = (res: Response, status: number, user: UserRow, error: string | null) =>
    res.status(status).render('admin/usuario-senha', {
      title: 'Redefinir senha',
      user: {
        id: user.id,
        name: decryptName(crypto, user),
        email: decryptEmail(crypto, user),
        phone: decryptPhone(crypto, user),
        resetRequestedAt: user.passwordResetRequestedAt,
      },
      error,
    });

  router.get('/usuarios/:id/redefinir-senha', async (req, res) => {
    const user = await managedUser(req);
    if (!user) return renderNotFound(req, res);
    renderResetForm(res, 200, user, null);
  });

  router.post('/usuarios/:id/redefinir-senha', async (req, res) => {
    const user = await managedUser(req);
    if (!user) return renderNotFound(req, res);
    const password = chosenPassword(req);
    if (!password.ok) return renderResetForm(res, 422, user, password.error);

    await setPassword(db, user.id, password.password, { mustChangePassword: true });
    const name = decryptName(crypto, user);
    if (password.generated) {
      return renderGeneratedPassword(res, {
        heading: 'Senha redefinida',
        name,
        email: decryptEmail(crypto, user),
        password: password.password,
      });
    }
    flash(req, 'success', `Senha de ${name} redefinida. Envie a nova senha por fora do sistema.`);
    res.redirect('/admin/usuarios');
  });

  return router;
}
