import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../../app.js';
import { formatList } from '../../http/format.js';
import { isUuid } from '../../http/forms.js';
import { flash, renderNotFound, userOnly } from '../../http/session.js';
import { findBankAccess, loadPanel } from '../banks/banks.service.js';
import { listGroupsOfUser } from '../groups/groups.service.js';
import { elapsedSeconds, letterLabel, OPTION_COUNT } from './attempt-logic.js';
import {
  attemptTitle,
  deleteReport,
  discardAttempt,
  findOwnAttempt,
  finishAttempt,
  lastPage,
  listAttemptBanks,
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

/** Com "Todas" ou "Sem limite" marcado, o número ao lado (que sempre vem preenchido) não vale. */
function startOptionsFrom(body: Record<string, unknown> = {}) {
  return {
    quantidade: body.modoQuantidade === 'todas' ? undefined : body.quantidade,
    minutos: body.modoTempo === 'sem-limite' ? undefined : body.minutos,
  };
}

/** A caixa "Embaralhar" só vem no formulário quando está marcada. */
const shuffledFrom = (body: Record<string, unknown> = {}) => body.embaralhar === '1';

/** O que a pessoa preencheu nas opções, para mostrar de novo junto com o erro. */
function startValuesFrom(body: Record<string, unknown> = {}) {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return {
    modoQuantidade: text(body.modoQuantidade),
    quantidade: text(body.quantidade),
    modoTempo: text(body.modoTempo),
    minutos: text(body.minutos),
    embaralhar: shuffledFrom(body),
  };
}

/** Um simulado que dá para juntar com outros. */
interface BankChoice {
  id: string;
  title: string;
  questionCount: number;
  origin: string;
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

  /** Simulados da tentativa (um, ou vários quando ela junta mais de um). */
  const banksOf = async (attempt: AttemptRow) =>
    (await listAttemptBanks(db, crypto, [attempt.id])).get(attempt.id) ?? [];

  async function renderExam(
    res: Response,
    attempt: AttemptRow,
    page: number,
    blankModal: { blanks: number[] } | null = null,
  ) {
    res.render('simulados/prova', {
      title: attemptTitle(await banksOf(attempt)),
      attempt: { id: attempt.id, bankId: attempt.bankId },
      exam: await loadExamPage(db, crypto, attempt.id, page),
      clock: clockOf(attempt),
      letterLabel,
      blankModal,
    });
  }

  router.post('/bancos/:id/simulados', ...userOnly, async (req, res) => {
    const access = isUuid(req.params.id)
      ? await findBankAccess(db, crypto, req.currentUser!.id, req.params.id)
      : null;
    if (!access) return renderNotFound(req, res);

    const parsed = startOptionsSchema(access.bank.questionCount).safeParse(
      startOptionsFrom(req.body),
    );
    if (!parsed.success) {
      flash(req, 'error', parsed.error.issues[0]!.message);
      return res.redirect(`/bancos/${access.bank.id}`);
    }
    const attemptId = await startAttempt(db, {
      userId: req.currentUser!.id,
      bankIds: [access.bank.id],
      count: parsed.data.quantidade,
      timeLimitSeconds: parsed.data.minutos ? parsed.data.minutos * 60 : null,
      shuffled: shuffledFrom(req.body),
    });
    res.redirect(`/simulados/${attemptId}`);
  });

  /** Simulados que dá para juntar: os próprios, os recebidos e os dos grupos, sem repetir. */
  async function loadChoices(userId: string): Promise<BankChoice[]> {
    const panel = await loadPanel(db, crypto, userId, await listGroupsOfUser(db, crypto, userId));
    const choices = new Map<string, BankChoice & { groups: string[] }>();
    const add = (bank: (typeof panel.mine)[number], origin: string, group?: string) => {
      const existing = choices.get(bank.id);
      if (existing) {
        if (group) existing.groups.push(group);
        return;
      }
      const { id, title, questionCount } = bank;
      choices.set(id, { id, title, questionCount, origin, groups: group ? [group] : [] });
    };
    for (const bank of panel.mine) add(bank, 'Seu');
    for (const bank of panel.received) add(bank, `Recebido de ${bank.ownerName}`);
    for (const group of panel.groups) {
      for (const bank of group.banks) add(bank, `Enviado por ${bank.ownerName}`, group.name);
    }
    return [...choices.values()].map(({ groups, ...choice }) => ({
      ...choice,
      origin: groups.length ? `${choice.origin} em ${formatList(groups)}` : choice.origin,
    }));
  }

  async function renderMultiple(
    req: Request,
    res: Response,
    form: { errors?: string[]; selected?: string[]; values?: ReturnType<typeof startValuesFrom> },
  ) {
    const choices = await loadChoices(req.currentUser!.id);
    res.status(form.errors?.length ? 422 : 200).render('simulados/multiplos', {
      title: 'Múltiplos simulados',
      choices,
      totalQuestions: choices.reduce((sum, choice) => sum + choice.questionCount, 0),
      errors: form.errors ?? [],
      selected: form.selected ?? [],
      values: form.values ?? {},
      maxMinutes: MAX_TIME_LIMIT_MINUTES,
    });
  }

  router.get('/simulados/multiplos', ...userOnly, (req, res) => renderMultiple(req, res, {}));

  router.post('/simulados/multiplos', ...userOnly, async (req, res) => {
    const marked = new Set([req.body?.bancos].flat().filter((id) => isUuid(id)));
    const choices = await loadChoices(req.currentUser!.id);
    const chosen = choices.filter((choice) => marked.has(choice.id));
    const form = { selected: chosen.map((choice) => choice.id), values: startValuesFrom(req.body) };

    if (chosen.length < marked.size) {
      return renderMultiple(req, res, {
        ...form,
        errors: [
          'Algum simulado marcado não está mais disponível. Confira a lista e tente de novo.',
        ],
      });
    }
    if (!chosen.length) {
      return renderMultiple(req, res, { ...form, errors: ['Marque pelo menos um simulado.'] });
    }
    const total = chosen.reduce((sum, choice) => sum + choice.questionCount, 0);
    const parsed = startOptionsSchema(total).safeParse(startOptionsFrom(req.body));
    if (!parsed.success) {
      return renderMultiple(req, res, { ...form, errors: [parsed.error.issues[0]!.message] });
    }
    const attemptId = await startAttempt(db, {
      userId: req.currentUser!.id,
      bankIds: form.selected,
      count: parsed.data.quantidade,
      timeLimitSeconds: parsed.data.minutos ? parsed.data.minutos * 60 : null,
      shuffled: form.values.embaralhar,
    });
    res.redirect(`/simulados/${attemptId}`);
  });

  router.get('/simulados/:id', ...userOnly, async (req, res) => {
    const attempt = await attemptFromParams(req);
    if (!attempt) return renderNotFound(req, res);
    if (await settleIfExpired(db, crypto, attempt)) return res.redirect(reportPath(attempt));

    await renderExam(res, attempt, positiveInt(req.query.pagina) ?? 1);
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

    // Com questões em branco, a prova volta (na última página) com a janela de confirmação.
    const blanks = await listBlankNumbers(db, attempt.id);
    if (blanks.length && req.body?.confirmar !== '1') {
      return renderExam(res, attempt, await lastPage(db, attempt.id), { blanks });
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

  /**
   * Depois de descartar ou excluir, volta para a página do simulado. Sem nenhuma tentativa, quem
   * recebeu o simulado por um grupo que já acabou perde o acesso; aí (e na tentativa com vários
   * simulados) volta para o painel.
   */
  async function pathAfterRemoving(attempt: AttemptRow) {
    const access =
      attempt.bankId && (await findBankAccess(db, crypto, attempt.userId, attempt.bankId));
    return access ? `/bancos/${attempt.bankId}` : '/';
  }

  router.post('/simulados/:id/descartar', ...userOnly, async (req, res) => {
    const attempt = await attemptFromParams(req);
    if (!attempt) return renderNotFound(req, res);

    if ((await settleIfExpired(db, crypto, attempt)) || !(await discardAttempt(db, attempt.id))) {
      flash(req, 'error', 'Só dá para descartar uma tentativa em andamento.');
    } else {
      flash(req, 'success', 'Tentativa descartada.');
    }
    res.redirect(await pathAfterRemoving(attempt));
  });

  router.post('/simulados/:id/excluir', ...userOnly, async (req, res) => {
    const attempt = await attemptFromParams(req);
    if (!attempt) return renderNotFound(req, res);

    await settleIfExpired(db, crypto, attempt);
    if (await deleteReport(db, attempt.id)) {
      flash(req, 'success', 'Relatório excluído.');
    } else {
      flash(req, 'error', 'Só dá para excluir o relatório de uma tentativa finalizada.');
    }
    res.redirect(req.body?.voltar === 'painel' ? '/' : await pathAfterRemoving(attempt));
  });

  router.get('/simulados/:id/relatorio', ...userOnly, async (req, res) => {
    let attempt = await attemptFromParams(req);
    if (!attempt) return renderNotFound(req, res);
    if (!(await settleIfExpired(db, crypto, attempt))) return res.redirect(examPath(attempt));
    if (attempt.status !== 'finished') attempt = (await attemptFromParams(req))!;

    const banks = await banksOf(attempt);
    const bankTitle = attemptTitle(banks);
    // Quem perdeu o acesso (o dono que excluiu o simulado) continua vendo os próprios relatórios.
    const canOpenBank = Boolean(
      attempt.bankId && (await findBankAccess(db, crypto, attempt.userId, attempt.bankId)),
    );
    res.render('simulados/relatorio', {
      title: `Relatório: ${bankTitle}`,
      bankTitle,
      banks,
      canOpenBank,
      attempt,
      items: await loadReportItems(db, crypto, attempt.id),
      letterLabel,
    });
  });

  return router;
}
