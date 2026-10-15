import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { isUuid } from '../../http/forms.js';
import { flash, renderNotFound, userOnly } from '../../http/session.js';
import { findBankAccess, findBankTitle } from '../banks/banks.service.js';
import { elapsedSeconds, letterLabel, OPTION_COUNT } from './attempt-logic.js';
import {
  discardAttempt,
  findOwnAttempt,
  finishAttempt,
  lastPage,
  listBlankNumbers,
  loadExamPage,
  loadReportItems,
  pageOfQuestion,
  reorganizeAttempt,
  saveAnswers,
  settleIfExpired,
  startAttempt,
  type AnswerInput,
  type AttemptRow,
} from './attempts.service.js';

export const MAX_TIME_LIMIT_MINUTES = 600;

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** Opções do "Iniciar novo simulado". Campo vazio = todas as questões / sem tempo limite. */
function startOptionsSchema(total: number) {
  const countError = `Informe uma quantidade de questões entre 1 e ${total}.`;
  const minutesError = `Informe o tempo limite em minutos, entre 1 e ${MAX_TIME_LIMIT_MINUTES}, ou deixe em branco para fazer sem limite.`;
  return z.object({
    quantidade: z.preprocess(
      emptyToUndefined,
      z.coerce
        .number({ error: countError })
        .int(countError)
        .min(1, countError)
        .max(total, countError)
        .optional(),
    ),
    minutos: z.preprocess(
      emptyToUndefined,
      z.coerce
        .number({ error: minutesError })
        .int(minutesError)
        .min(1, minutesError)
        .max(MAX_TIME_LIMIT_MINUTES, minutesError)
        .optional(),
    ),
  });
}

const positiveInt = (value: unknown) => {
  const number = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : NaN;
  return number >= 1 ? number : null;
};

/** Radios da prova: name="q<número>" e value = letra marcada (0 = A). */
function answersFromForm(body: Record<string, unknown> | undefined): AnswerInput[] {
  const answers: AnswerInput[] = [];
  for (const [key, value] of Object.entries(body ?? {})) {
    const match = /^q(\d{1,6})$/.exec(key);
    if (!match || typeof value !== 'string' || !/^\d$/.test(value)) continue;
    const letter = Number(value);
    if (letter < OPTION_COUNT) answers.push({ number: Number(match[1]), letter });
  }
  return answers;
}

export function attemptRoutes({ db, crypto }: AppDeps): Router {
  const router = Router();

  const examPath = (attempt: Pick<AttemptRow, 'id'>, page?: number | null) =>
    `/simulados/${attempt.id}${page ? `?pagina=${page}` : ''}`;
  const reportPath = (attempt: Pick<AttemptRow, 'id'>) => `/simulados/${attempt.id}/relatorio`;

  /** Tentativa do usuário logado; a de outra pessoa (ou um id inválido) dá undefined → 404. */
  const attemptFromParams = (req: Request) =>
    isUuid(req.params.id)
      ? findOwnAttempt(db, req.currentUser!.id, req.params.id)
      : Promise.resolve(undefined);

  /** Segundos que o cronômetro mostra ao abrir a página: decorrido e, se houver limite, restante. */
  const clockOf = (attempt: AttemptRow) => {
    const now = new Date();
    return {
      elapsed: elapsedSeconds(attempt.startedAt, now),
      // Arredonda para cima: a página nunca finaliza antes do prazo do servidor.
      remaining: attempt.deadlineAt
        ? Math.max(0, Math.ceil((attempt.deadlineAt.getTime() - now.getTime()) / 1000))
        : null,
    };
  };

  router.post('/bancos/:id/simulados', ...userOnly, async (req, res) => {
    const access = isUuid(req.params.id)
      ? await findBankAccess(db, crypto, req.currentUser!.id, req.params.id)
      : null;
    if (!access) return renderNotFound(req, res);

    const parsed = startOptionsSchema(access.bank.questionCount).safeParse(req.body ?? {});
    if (!parsed.success) {
      flash(req, 'error', parsed.error.issues[0]!.message);
      return res.redirect(`/bancos/${access.bank.id}`);
    }
    const attemptId = await startAttempt(db, {
      userId: req.currentUser!.id,
      bankId: access.bank.id,
      count: parsed.data.quantidade,
      timeLimitSeconds: parsed.data.minutos ? parsed.data.minutos * 60 : null,
    });
    res.redirect(`/simulados/${attemptId}`);
  });

  router.get('/simulados/:id', ...userOnly, async (req, res) => {
    const attempt = await attemptFromParams(req);
    if (!attempt) return renderNotFound(req, res);
    if (await settleIfExpired(db, crypto, attempt)) return res.redirect(reportPath(attempt));

    const exam = await loadExamPage(db, crypto, attempt.id, positiveInt(req.query.pagina) ?? 1);
    res.render('simulados/prova', {
      title: await findBankTitle(db, crypto, attempt.bankId),
      attempt: { id: attempt.id, bankId: attempt.bankId },
      exam,
      clock: clockOf(attempt),
      letterLabel,
    });
  });

  /** Salva as respostas do formulário; se o prazo venceu, finaliza e avisa o que não foi salvo. */
  async function saveFormAnswers(req: Request, attempt: AttemptRow) {
    const answers = answersFromForm(req.body);
    const { accepted } = await saveAnswers(db, attempt.id, answers);
    const closed = await settleIfExpired(db, crypto, attempt);
    if (closed && !accepted && answers.length) {
      flash(
        req,
        'info',
        'O tempo limite acabou. As respostas enviadas depois do prazo não foram salvas.',
      );
    }
    return closed;
  }

  router.post('/simulados/:id/pagina', ...userOnly, async (req, res) => {
    const attempt = await attemptFromParams(req);
    if (!attempt) return renderNotFound(req, res);
    if (attempt.status === 'finished' || (await saveFormAnswers(req, attempt))) {
      return res.redirect(reportPath(attempt));
    }

    // Mapa de questões: vai à página da questão e rola a tela até ela.
    const target = positiveInt(req.body?.ir);
    const targetPage = target ? await pageOfQuestion(db, attempt.id, target) : null;
    if (targetPage) return res.redirect(`${examPath(attempt, targetPage)}#questao-${target}`);
    res.redirect(examPath(attempt, positiveInt(req.body?.destino) ?? 1));
  });

  router.put('/api/simulados/:id/respostas/:numero', ...userOnly, async (req, res) => {
    const attempt = await attemptFromParams(req);
    if (!attempt) return res.status(404).json({ erro: 'Simulado não encontrado.' });

    const number = positiveInt(req.params.numero);
    const letter: unknown = req.body?.alternativa;
    const valid =
      typeof letter === 'number' &&
      Number.isInteger(letter) &&
      letter >= 0 &&
      letter < OPTION_COUNT;
    if (!number || number > attempt.totalQuestions || !valid) {
      return res.status(400).json({ erro: 'Resposta inválida.' });
    }
    const { accepted, answered } = await saveAnswers(db, attempt.id, [{ number, letter }]);
    if (!accepted) {
      await settleIfExpired(db, crypto, attempt);
      return res.status(409).json({ finalizado: true, relatorio: reportPath(attempt) });
    }
    res.json({ respondidas: answered });
  });

  router.post('/simulados/:id/finalizar', ...userOnly, async (req, res) => {
    const attempt = await attemptFromParams(req);
    if (!attempt) return renderNotFound(req, res);
    if (attempt.status === 'finished' || (await saveFormAnswers(req, attempt))) {
      return res.redirect(reportPath(attempt));
    }

    const blanks = await listBlankNumbers(db, attempt.id);
    if (blanks.length && req.body?.confirmar !== '1') {
      return res.render('simulados/confirmar', {
        title: await findBankTitle(db, crypto, attempt.bankId),
        attempt: { id: attempt.id },
        blanks,
        clock: clockOf(attempt),
        returnPage: await lastPage(db, attempt.id),
      });
    }
    await finishAttempt(db, crypto, attempt.id, 'user');
    res.redirect(reportPath(attempt));
  });

  router.post('/simulados/:id/reorganizar', ...userOnly, async (req, res) => {
    const attempt = await attemptFromParams(req);
    if (!attempt) return renderNotFound(req, res);
    if (await settleIfExpired(db, crypto, attempt)) return res.redirect(reportPath(attempt));

    const firstBlankPage = await reorganizeAttempt(db, attempt.id);
    res.redirect(examPath(attempt, firstBlankPage ?? (await lastPage(db, attempt.id))));
  });

  router.post('/simulados/:id/descartar', ...userOnly, async (req, res) => {
    const attempt = await attemptFromParams(req);
    if (!attempt) return renderNotFound(req, res);
    const user = req.currentUser!;

    if ((await settleIfExpired(db, crypto, attempt)) || !(await discardAttempt(db, attempt.id))) {
      flash(req, 'error', 'Só dá para descartar uma tentativa em andamento.');
    } else {
      flash(req, 'success', 'Tentativa descartada.');
    }
    // Sem nenhuma tentativa, quem recebeu o simulado por um grupo que já acabou perde o acesso.
    const access = await findBankAccess(db, crypto, user.id, attempt.bankId);
    res.redirect(access ? `/bancos/${attempt.bankId}` : '/');
  });

  router.get('/simulados/:id/relatorio', ...userOnly, async (req, res) => {
    let attempt = await attemptFromParams(req);
    if (!attempt) return renderNotFound(req, res);
    if (!(await settleIfExpired(db, crypto, attempt))) return res.redirect(examPath(attempt));
    if (attempt.status !== 'finished') attempt = (await attemptFromParams(req))!;

    const bankTitle = await findBankTitle(db, crypto, attempt.bankId);
    // Quem perdeu o acesso (o dono que excluiu o simulado) continua vendo os próprios relatórios.
    const canOpenBank = Boolean(await findBankAccess(db, crypto, attempt.userId, attempt.bankId));
    res.render('simulados/relatorio', {
      title: `Relatório: ${bankTitle}`,
      bankTitle,
      canOpenBank,
      attempt,
      items: await loadReportItems(db, crypto, attempt.id),
      letterLabel,
    });
  });

  return router;
}
