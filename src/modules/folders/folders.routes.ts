import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { plural } from '../../http/format.js';
import { idListField, isUuid, singleLine, textField } from '../../http/forms.js';
import { flash, renderNotFound, userOnly } from '../../http/session.js';
import { loadMyBanks, type MyBanks } from '../banks/banks.service.js';
import {
  createFolder,
  decryptFolderName,
  deleteFolder,
  findFolder,
  FOLDER_NAME_MAX_LENGTH,
  isFolderNameTaken,
  moveBanksToFolder,
  removeBanksFromFolders,
  renameFolder,
  type FolderRow,
} from './folders.service.js';

const nameSchema = z
  .string({ error: 'Informe o nome da pasta.' })
  .transform((value) => singleLine(value.replace(/\p{Cc}/gu, ' ')))
  .pipe(
    z
      .string()
      .min(1, 'Informe o nome da pasta.')
      .max(
        FOLDER_NAME_MAX_LENGTH,
        `O nome pode ter no máximo ${FOLDER_NAME_MAX_LENGTH} caracteres.`,
      ),
  );

/** Simulado para marcar, com quem enviou (se for recebido) e a pasta em que está agora. */
interface FolderChoice {
  id: string;
  title: string;
  questionCount: number;
  ownerName: string | null;
  folderName: string | null;
}

/** Meus simulados numa lista só: os próprios e depois os recebidos. */
const allBanks = (my: MyBanks) => [...my.mine, ...my.received];

/** Os simulados que podem entrar na pasta (os que ainda não estão nela). */
function choicesFor(my: MyBanks, folderId?: string): FolderChoice[] {
  const folderNames = new Map(my.folders.map((folder) => [folder.id, folder.name]));
  return allBanks(my)
    .filter((bank) => !folderId || bank.folderId !== folderId)
    .map((bank) => ({
      id: bank.id,
      title: bank.title,
      questionCount: bank.questionCount,
      ownerName: bank.ownerName,
      folderName: bank.folderId ? (folderNames.get(bank.folderId) ?? null) : null,
    }));
}

export function folderRoutes({ db, crypto }: AppDeps): Router {
  const router = Router();

  const folderFromParams = (req: Request) =>
    isUuid(req.params.id)
      ? findFolder(db, req.currentUser!.id, req.params.id)
      : Promise.resolve(undefined);

  /** Valida o nome e confere se o usuário já tem outra pasta com o mesmo (sem maiúsculas e acentos). */
  async function validateName(req: Request, exceptFolderId?: string) {
    const parsed = nameSchema.safeParse(req.body?.nome);
    if (!parsed.success) return { ok: false as const, error: parsed.error.issues[0]!.message };
    if (await isFolderNameTaken(db, crypto, req.currentUser!.id, parsed.data, exceptFolderId)) {
      return { ok: false as const, error: 'Você já tem uma pasta com esse nome.' };
    }
    return { ok: true as const, name: parsed.data };
  }

  /** Só os simulados de Meus simulados entram numa pasta; os outros ids são ignorados. */
  async function markedBanks(req: Request) {
    const available = new Set(
      allBanks(await loadMyBanks(db, crypto, req.currentUser!.id)).map((bank) => bank.id),
    );
    return idListField(req, 'bancos').filter((id) => available.has(id));
  }

  async function renderNew(
    req: Request,
    res: Response,
    status: number,
    view: { nome?: string; errors?: string[]; selected?: string[] } = {},
  ) {
    const my = await loadMyBanks(db, crypto, req.currentUser!.id);
    res.status(status).render('pastas/nova', {
      title: 'Nova pasta',
      nome: view.nome ?? '',
      errors: view.errors ?? [],
      choices: choicesFor(my),
      selected: view.selected ?? [],
      nameMaxLength: FOLDER_NAME_MAX_LENGTH,
    });
  }

  async function renderFolder(
    req: Request,
    res: Response,
    status: number,
    folder: FolderRow,
    view: { nome?: string; error?: string } = {},
  ) {
    const my = await loadMyBanks(db, crypto, req.currentUser!.id);
    const name = decryptFolderName(crypto, folder);
    res.status(status).render('pastas/pasta', {
      title: name,
      folder: { id: folder.id, name },
      banks: allBanks(my).filter((bank) => bank.folderId === folder.id),
      choices: choicesFor(my, folder.id),
      nome: view.nome ?? name,
      error: view.error ?? '',
      nameMaxLength: FOLDER_NAME_MAX_LENGTH,
    });
  }

  router.get('/pastas/nova', ...userOnly, (req, res) => renderNew(req, res, 200));

  router.post('/pastas', ...userOnly, async (req, res) => {
    const result = await validateName(req);
    if (!result.ok) {
      return renderNew(req, res, 422, {
        nome: textField(req, 'nome', FOLDER_NAME_MAX_LENGTH),
        errors: [result.error],
        selected: idListField(req, 'bancos'),
      });
    }
    const id = await createFolder(
      db,
      crypto,
      req.currentUser!.id,
      result.name,
      await markedBanks(req),
    );
    flash(req, 'success', `Pasta ${result.name} criada.`);
    res.redirect(`/pastas/${id}`);
  });

  router.get('/pastas/:id', ...userOnly, async (req, res) => {
    const folder = await folderFromParams(req);
    if (!folder) return renderNotFound(req, res);
    await renderFolder(req, res, 200, folder);
  });

  router.post('/pastas/:id', ...userOnly, async (req, res) => {
    const folder = await folderFromParams(req);
    if (!folder) return renderNotFound(req, res);
    const result = await validateName(req, folder.id);
    if (!result.ok) {
      return renderFolder(req, res, 422, folder, {
        nome: textField(req, 'nome', FOLDER_NAME_MAX_LENGTH),
        error: result.error,
      });
    }
    await renameFolder(db, crypto, folder.id, result.name);
    flash(req, 'success', 'Nome da pasta atualizado.');
    res.redirect(`/pastas/${folder.id}`);
  });

  router.post('/pastas/:id/simulados', ...userOnly, async (req, res) => {
    const folder = await folderFromParams(req);
    if (!folder) return renderNotFound(req, res);
    const chosen = await markedBanks(req);
    if (!chosen.length) {
      flash(req, 'error', 'Marque pelo menos um simulado para guardar na pasta.');
    } else {
      await moveBanksToFolder(db, req.currentUser!.id, folder.id, chosen);
      flash(
        req,
        'success',
        `${plural(chosen.length, 'simulado guardado', 'simulados guardados')} na pasta.`,
      );
    }
    res.redirect(`/pastas/${folder.id}`);
  });

  router.post('/pastas/:id/simulados/:bankId/remover', ...userOnly, async (req, res) => {
    const folder = await folderFromParams(req);
    if (!folder || !isUuid(req.params.bankId)) return renderNotFound(req, res);
    await removeBanksFromFolders(db, req.currentUser!.id, [req.params.bankId]);
    flash(req, 'success', 'Simulado tirado da pasta. Ele continua em Meus simulados.');
    res.redirect(`/pastas/${folder.id}`);
  });

  router.post('/pastas/:id/excluir', ...userOnly, async (req, res) => {
    const folder = await folderFromParams(req);
    if (!folder) return renderNotFound(req, res);
    await deleteFolder(db, folder.id);
    flash(
      req,
      'success',
      `Pasta ${decryptFolderName(crypto, folder)} excluída. Os simulados dela continuam em Meus simulados.`,
    );
    res.redirect('/');
  });

  return router;
}
