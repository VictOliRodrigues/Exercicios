import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { AppDeps } from '../../app.js';
import type { Env } from '../../config/env.js';
import { idListField, isUuid } from '../../http/forms.js';
import { flash, renderNotFound, userOnly } from '../../http/session.js';
import { buildGptFixMessage } from '../../markdown/gpt-fix-message.js';
import { describeIssue, parseQuestions } from '../../markdown/parse-questions.js';
import { listGroupsOfUser, type GroupSummary } from '../groups/groups.service.js';
import {
  deleteBank,
  findBankAccess,
  findOwnerName,
  importBank,
  listSharedGroups,
  setBankGroups,
} from './banks.service.js';

const MODELS_DIR = path.join(import.meta.dirname, '../../../modelos');
const MODEL_FILE = 'modelo-questoes.md';
const PROMPT_FILE = 'prompt-chatgpt.txt';
const promptText = readFileSync(path.join(MODELS_DIR, PROMPT_FILE), 'utf8');

const ORIGINAL_NAME_MAX_LENGTH = 255;
const TITLE_MAX_LENGTH = 200;

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

interface ImportView {
  selectedGroups?: string[];
  fileError?: string | null;
  issues?: string[];
  gptMessage?: string | null;
}

export function bankRoutes({ db, crypto, env, fileStore }: AppDeps): Router {
  const router = Router();
  const maxUploadLabel = `${env.MAX_UPLOAD_MB.toLocaleString('pt-BR')} MB`;

  const renderImport = (
    res: Response,
    status: number,
    myGroups: GroupSummary[],
    view: ImportView,
  ) =>
    res.status(status).render('bancos/importar', {
      title: 'Importar simulado',
      myGroups,
      promptText,
      maxUploadLabel,
      selectedGroups: view.selectedGroups ?? [],
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

  router.get('/bancos/importar', ...userOnly, async (req, res) => {
    renderImport(res, 200, await listGroupsOfUser(db, crypto, req.currentUser!.id), {});
  });

  router.post('/bancos', ...userOnly, async (req, res) => {
    const user = req.currentUser!;
    const myGroups = await listGroupsOfUser(db, crypto, user.id);
    const selectedGroups = idListField(req, 'grupos');
    const fail = (status: number, view: ImportView) =>
      renderImport(res, status, myGroups, { selectedGroups, ...view });

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
    const myGroupIds = new Set(myGroups.map((group) => group.id));
    if (!selectedGroups.every((id) => myGroupIds.has(id))) {
      return fail(422, { fileError: 'Você só pode compartilhar com os grupos de que participa.' });
    }

    const parsed = parseQuestions(text);
    if (parsed.errors.length) {
      return fail(422, {
        issues: parsed.errors.map(describeIssue),
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

    const importResult = req.session.importResult;
    if (importResult) delete req.session.importResult;

    res.render('bancos/banco', {
      title: crypto.decryptField(bank.titleEnc, 'question_banks', 'title', bank.id),
      bank: { id: bank.id, questionCount: bank.questionCount, createdAt: bank.createdAt },
      isOwner,
      viaGroups,
      ownerName: isOwner ? null : await findOwnerName(db, crypto, bank.userId),
      sharedGroups: isOwner ? await listSharedGroups(db, crypto, bank.id) : [],
      myGroups: isOwner ? await listGroupsOfUser(db, crypto, req.currentUser!.id) : [],
      importResult: importResult?.bankId === bank.id ? importResult : null,
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

  router.post('/bancos/:id/excluir', ...userOnly, async (req, res) => {
    const access = await accessFromParams(req);
    if (!access?.isOwner) return renderNotFound(req, res);
    await deleteBank(db, access.bank.id);
    flash(req, 'success', 'Simulado excluído.');
    res.redirect('/');
  });

  return router;
}
