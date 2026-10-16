import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import type { Env } from '../../config/env.js';
import { idListField, isUuid, singleLine } from '../../http/forms.js';
import { flash, renderNotFound, userOnly } from '../../http/session.js';
import { buildGptFixMessage } from '../../markdown/gpt-fix-message.js';
import { parseQuestions } from '../../markdown/parse-questions.js';
import { MAX_TIME_LIMIT_MINUTES } from '../attempts/attempts.routes.js';
import { listAttemptsForBank, settleExpiredAttempts } from '../attempts/attempts.service.js';
import {
  findBankFolder,
  listFolders,
  moveBanksToFolder,
  removeBanksFromFolders,
  type FolderSummary,
} from '../folders/folders.service.js';
import { listGroupsOfUser, type GroupSummary } from '../groups/groups.service.js';
import {
  deleteBank,
  findBankAccess,
  findOwnerName,
  importBank,
  listSharedGroups,
  renameBank,
  setBankGroups,
  type BankAccess,
} from './banks.service.js';

const MODELS_DIR = path.join(import.meta.dirname, '../../../modelos');
const MODEL_FILE = 'modelo-questoes.md';
const PROMPT_FILE = 'prompt-chatgpt.txt';
const promptText = readFileSync(path.join(MODELS_DIR, PROMPT_FILE), 'utf8');

const ORIGINAL_NAME_MAX_LENGTH = 255;
const TITLE_MAX_LENGTH = 200;

const titleSchema = z
  .string({ error: 'Informe o nome do simulado.' })
  .transform((value) => singleLine(value.replace(/\p{Cc}/gu, ' ')))
  .pipe(
    z
      .string()
      .min(1, 'Informe o nome do simulado.')
      .max(TITLE_MAX_LENGTH, `O nome pode ter no máximo ${TITLE_MAX_LENGTH} caracteres.`),
  );

/** Os simulados de Meus simulados (os próprios e os recebidos) podem ir para uma pasta. */
const canFile = (access: BankAccess) => access.isOwner || access.viaGroups.length === 0;

/**
 * Lê o upload antes da checagem de CSRF (o token vem no próprio formulário multipart). Só roda
 * para usuário comum logado; um erro do multer vira mensagem na tela, não página de erro.
 */
export function bankUploadParser(env: Env) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: env.MAX_UPLOAD_MB * 1024 * 1024,
      files: 1,
      fields: 100,
      fieldSize: 10_000,
    },
    // Os navegadores mandam o nome do arquivo em UTF-8 sem declarar; o padrão do multer é latin1.
    defParamCharset: 'utf8',
  }).single('arquivo');

  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.currentUser;
    if (user?.role !== 'user' || user.mustChangePassword) return next();
    upload(req, res, (error: unknown) => {
      if (error) {
        res.locals.uploadError = error instanceof multer.MulterError ? error.code : 'INVALID';
      }
      next();
    });
  };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(content: Buffer): string | null {
  try {
    return utf8.decode(content);
  } catch {
    return null;
  }
}

/** Nome do arquivo sem pastas e sem caracteres de controle. */
function cleanFileName(name: string): string {
  return path
    .basename(name.replaceAll('\\', '/'))
    .replace(/[\p{Cc}]/gu, '')
    .trim()
    .slice(0, ORIGINAL_NAME_MAX_LENGTH);
}

/** Sem "# Título" no arquivo, o título vem do nome do arquivo. */
function titleFromFileName(name: string): string {
  const base = name.replace(/\.md$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (base || 'Simulado sem título').slice(0, TITLE_MAX_LENGTH);
}

/** Problema do arquivo, como a tela mostra: "Questão 4 · linha 37" e o detalhe. */
interface IssueView {
  question: number | null;
  line: number | null;
  detail: string;
}

interface ImportView {
  selectedGroups?: string[];
  selectedFolder?: string;
  fileError?: string | null;
  issues?: IssueView[];
  gptMessage?: string | null;
}

export function bankRoutes({ db, crypto, env, fileStore }: AppDeps): Router {
  const router = Router();
  const maxUploadLabel = `${env.MAX_UPLOAD_MB.toLocaleString('pt-BR')} MB`;

  const renderImport = (
    res: Response,
    status: number,
    mine: { groups: GroupSummary[]; folders: FolderSummary[] },
    view: ImportView,
  ) =>
    res.status(status).render('bancos/importar', {
      title: 'Importar simulado',
      myGroups: mine.groups,
      myFolders: mine.folders,
      promptText,
      maxUploadLabel,
      selectedGroups: view.selectedGroups ?? [],
      selectedFolder: view.selectedFolder ?? '',
      fileError: view.fileError ?? null,
      issues: view.issues ?? [],
      gptMessage: view.gptMessage ?? null,
    });

  router.get('/modelos/:arquivo', ...userOnly, (req, res) => {
    const file = req.params.arquivo;
    if (file !== MODEL_FILE && file !== PROMPT_FILE) return renderNotFound(req, res);
    res.attachment(file);
    res.type(file === MODEL_FILE ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8');
    res.sendFile(path.join(MODELS_DIR, file));
  });

  const groupsAndFolders = async (userId: string) => ({
    groups: await listGroupsOfUser(db, crypto, userId),
    folders: await listFolders(db, crypto, userId),
  });

  router.get('/bancos/importar', ...userOnly, async (req, res) => {
    renderImport(res, 200, await groupsAndFolders(req.currentUser!.id), {});
  });

  router.post('/bancos', ...userOnly, async (req, res) => {
    const user = req.currentUser!;
    const mine = await groupsAndFolders(user.id);
    const selectedGroups = idListField(req, 'grupos');
    const folderField: unknown = req.body?.pasta;
    const selectedFolder = isUuid(folderField) ? folderField : '';
    const fail = (status: number, view: ImportView) =>
      renderImport(res, status, mine, { selectedGroups, selectedFolder, ...view });

    const uploadError: unknown = res.locals.uploadError;
    if (uploadError === 'LIMIT_FILE_SIZE') {
      return fail(413, { fileError: `O arquivo passa de ${maxUploadLabel}, o tamanho máximo.` });
    }
    if (uploadError || !req.file) {
      return fail(422, { fileError: 'Escolha um arquivo .md para importar.' });
    }
    const originalName = cleanFileName(req.file.originalname);
    if (!/\.md$/i.test(originalName)) {
      return fail(422, { fileError: 'O arquivo precisa ter a extensão .md.' });
    }
    const text = decodeUtf8(req.file.buffer);
    if (text === null) {
      return fail(422, {
        fileError:
          'O arquivo não está em UTF-8. Salve-o de novo com a codificação UTF-8 e tente outra vez.',
      });
    }
    const myGroupIds = new Set(mine.groups.map((group) => group.id));
    if (!selectedGroups.every((id) => myGroupIds.has(id))) {
      return fail(422, { fileError: 'Você só pode compartilhar com os grupos de que participa.' });
    }
    if (selectedFolder && !mine.folders.some((folder) => folder.id === selectedFolder)) {
      return fail(422, { fileError: 'Escolha uma das suas pastas.', selectedFolder: '' });
    }

    const parsed = parseQuestions(text);
    if (parsed.errors.length) {
      return fail(422, {
        issues: parsed.errors.map(({ question, line, detail }) => ({ question, line, detail })),
        gptMessage: buildGptFixMessage(parsed.errors),
      });
    }

    const bankId = await importBank(db, crypto, fileStore, {
      ownerId: user.id,
      title: parsed.title ?? titleFromFileName(originalName),
      originalName,
      content: req.file.buffer,
      questions: parsed.questions,
      groupIds: selectedGroups,
      folderId: selectedFolder || null,
    });
    req.session.importResult = {
      bankId,
      questionCount: parsed.questions.length,
      warnings: parsed.warnings,
    };
    res.redirect(`/bancos/${bankId}`);
  });

  /** Simulado que o usuário pode abrir; null quando ele não tem acesso (a rota responde 404). */
  const accessFromParams = (req: Request) =>
    isUuid(req.params.id)
      ? findBankAccess(db, crypto, req.currentUser!.id, req.params.id)
      : Promise.resolve(null);

  router.get('/bancos/:id', ...userOnly, async (req, res) => {
    const access = await accessFromParams(req);
    if (!access) return renderNotFound(req, res);
    const { bank, isOwner, viaGroups } = access;
    const userId = req.currentUser!.id;

    const importResult = req.session.importResult;
    if (importResult) delete req.session.importResult;
    await settleExpiredAttempts(db, crypto, userId);
    const filing = canFile(access);

    res.render('bancos/banco', {
      title: crypto.decryptField(bank.titleEnc, 'question_banks', 'title', bank.id),
      bank: { id: bank.id, questionCount: bank.questionCount, createdAt: bank.createdAt },
      isOwner,
      viaGroups,
      ownerName: isOwner ? null : await findOwnerName(db, crypto, bank.userId),
      sharedGroups: isOwner ? await listSharedGroups(db, crypto, bank.id) : [],
      myGroups: isOwner ? await listGroupsOfUser(db, crypto, userId) : [],
      canFile: filing,
      folder: filing ? await findBankFolder(db, crypto, userId, bank.id) : null,
      myFolders: filing ? await listFolders(db, crypto, userId) : [],
      titleMaxLength: TITLE_MAX_LENGTH,
      importResult: importResult?.bankId === bank.id ? importResult : null,
      attempts: await listAttemptsForBank(db, userId, bank.id),
      maxMinutes: MAX_TIME_LIMIT_MINUTES,
    });
  });

  router.post('/bancos/:id/compartilhamento', ...userOnly, async (req, res) => {
    const access = await accessFromParams(req);
    if (!access?.isOwner) return renderNotFound(req, res);

    const myGroups = await listGroupsOfUser(db, crypto, req.currentUser!.id);
    const myGroupIds = new Set(myGroups.map((group) => group.id));
    const selected = idListField(req, 'grupos');
    if (!selected.every((id) => myGroupIds.has(id))) {
      flash(req, 'error', 'Você só pode compartilhar com os grupos de que participa.');
      return res.redirect(`/bancos/${access.bank.id}`);
    }

    await setBankGroups(db, access.bank.id, selected);
    flash(
      req,
      'success',
      selected.length
        ? 'Compartilhamento atualizado.'
        : 'Compartilhamento atualizado: o simulado agora é privado.',
    );
    res.redirect(`/bancos/${access.bank.id}`);
  });

  router.post('/bancos/:id/nome', ...userOnly, async (req, res) => {
    const access = await accessFromParams(req);
    if (!access?.isOwner) return renderNotFound(req, res);
    const parsed = titleSchema.safeParse(req.body?.nome);
    if (!parsed.success) {
      flash(req, 'error', parsed.error.issues[0]!.message);
    } else {
      await renameBank(db, crypto, access.bank.id, parsed.data);
      flash(req, 'success', 'Nome do simulado atualizado.');
    }
    res.redirect(`/bancos/${access.bank.id}`);
  });

  /** Guarda numa pasta do usuário ou, com "Sem pasta" (valor vazio), tira da pasta. */
  router.post('/bancos/:id/pasta', ...userOnly, async (req, res) => {
    const access = await accessFromParams(req);
    if (!access || !canFile(access)) return renderNotFound(req, res);
    const userId = req.currentUser!.id;
    const bankId = access.bank.id;
    const folderId: unknown = req.body?.pasta;

    if (!folderId) {
      await removeBanksFromFolders(db, userId, [bankId]);
      flash(req, 'success', 'Simulado tirado da pasta.');
      return res.redirect(`/bancos/${bankId}`);
    }
    const folder = (await listFolders(db, crypto, userId)).find((item) => item.id === folderId);
    if (!folder) {
      flash(req, 'error', 'Escolha uma das suas pastas.');
      return res.redirect(`/bancos/${bankId}`);
    }
    await moveBanksToFolder(db, userId, folder.id, [bankId]);
    flash(req, 'success', `Simulado guardado na pasta ${folder.name}.`);
    res.redirect(`/bancos/${bankId}`);
  });

  router.post('/bancos/:id/excluir', ...userOnly, async (req, res) => {
    const access = await accessFromParams(req);
    if (!access?.isOwner) return renderNotFound(req, res);
    await deleteBank(db, access.bank.id);
    flash(req, 'success', 'Simulado excluído.');
    res.redirect('/');
  });

  return router;
}
