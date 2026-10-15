import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import type { studyGroups } from '../../db/schema.js';
import { idListField, isUuid, singleLine, textField } from '../../http/forms.js';
import { adminOnly, flash, renderNotFound } from '../../http/session.js';
import {
  addMembers,
  createGroup,
  decryptGroupName,
  deleteGroup,
  findGroup,
  GROUP_NAME_MAX_LENGTH,
  isGroupNameTaken,
  listGroupsForAdmin,
  listMembers,
  removeMember,
  renameGroup,
} from '../groups/groups.service.js';
import { listActiveUsersOutsideGroup } from '../users/users.service.js';

type GroupRow = typeof studyGroups.$inferSelect;

const nameSchema = z
  .string({ error: 'Informe o nome do grupo.' })
  .transform(singleLine)
  .pipe(
    z
      .string()
      .min(2, 'O nome do grupo precisa ter pelo menos 2 caracteres.')
      .max(GROUP_NAME_MAX_LENGTH, `O nome pode ter no máximo ${GROUP_NAME_MAX_LENGTH} caracteres.`),
  );

export function adminGroupsRoutes({ db, crypto }: AppDeps): Router {
  const router = Router();
  router.use(...adminOnly);

  const groupFromParams = (req: Request) =>
    isUuid(req.params.id) ? findGroup(db, req.params.id) : Promise.resolve(undefined);

  /** Valida o nome e confere se outro grupo já usa o mesmo (sem diferenciar maiúsculas e acentos). */
  async function validateName(req: Request, exceptGroupId?: string) {
    const parsed = nameSchema.safeParse(req.body?.nome);
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]!.message };
    if (await isGroupNameTaken(db, crypto, parsed.data, exceptGroupId)) {
      return { ok: false as const, error: 'Já existe um grupo com esse nome.' };
    }
    return { ok: true as const, name: parsed.data };
  }

  async function renderList(res: Response, status: number, view = { nome: '', error: '' }) {
    res.status(status).render('admin/grupos', {
      title: 'Grupos de estudo',
      groups: await listGroupsForAdmin(db, crypto),
      ...view,
    });
  }

  async function renderGroup(
    res: Response,
    status: number,
    group: GroupRow,
    view: { nome?: string; error?: string } = {},
  ) {
    const name = decryptGroupName(crypto, group);
    res.status(status).render('admin/grupo', {
      title: name,
      group: { id: group.id, name },
      members: await listMembers(db, crypto, group.id),
      candidates: await listActiveUsersOutsideGroup(db, crypto, group.id),
      nome: view.nome ?? name,
      error: view.error ?? '',
    });
  }

  router.get('/grupos', async (_req, res) => {
    await renderList(res, 200);
  });

  router.post('/grupos', async (req, res) => {
    const result = await validateName(req);
    if (!result.ok) {
      return renderList(res, 422, {
        nome: textField(req, 'nome', GROUP_NAME_MAX_LENGTH),
        error: result.error,
      });
    }
    const id = await createGroup(db, crypto, result.name);
    flash(req, 'success', `Grupo ${result.name} criado. Agora adicione os membros.`);
    res.redirect(`/admin/grupos/${id}`);
  });

  router.get('/grupos/:id', async (req, res) => {
    const group = await groupFromParams(req);
    if (!group) return renderNotFound(req, res);
    await renderGroup(res, 200, group);
  });

  router.post('/grupos/:id', async (req, res) => {
    const group = await groupFromParams(req);
    if (!group) return renderNotFound(req, res);
    const result = await validateName(req, group.id);
    if (!result.ok) {
      return renderGroup(res, 422, group, {
        nome: textField(req, 'nome', GROUP_NAME_MAX_LENGTH),
        error: result.error,
      });
    }
    await renameGroup(db, crypto, group.id, result.name);
    flash(req, 'success', 'Nome do grupo atualizado.');
    res.redirect(`/admin/grupos/${group.id}`);
  });

  router.post('/grupos/:id/excluir', async (req, res) => {
    const group = await groupFromParams(req);
    if (!group) return renderNotFound(req, res);
    await deleteGroup(db, group.id);
    flash(req, 'success', `Grupo ${decryptGroupName(crypto, group)} excluído.`);
    res.redirect('/admin/grupos');
  });

  router.post('/grupos/:id/membros', async (req, res) => {
    const group = await groupFromParams(req);
    if (!group) return renderNotFound(req, res);
    const added = await addMembers(db, group.id, idListField(req, 'usuarios'));
    if (added === 0) flash(req, 'error', 'Marque pelo menos um usuário para adicionar.');
    else
      flash(req, 'success', added === 1 ? '1 membro adicionado.' : `${added} membros adicionados.`);
    res.redirect(`/admin/grupos/${group.id}`);
  });

  router.post('/grupos/:id/membros/:userId/remover', async (req, res) => {
    const group = await groupFromParams(req);
    if (!group || !isUuid(req.params.userId)) return renderNotFound(req, res);
    await removeMember(db, group.id, req.params.userId);
    flash(req, 'success', 'Membro removido do grupo.');
    res.redirect(`/admin/grupos/${group.id}`);
  });

  return router;
}
