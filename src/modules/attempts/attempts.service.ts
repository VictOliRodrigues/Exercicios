import { and, asc, count, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { CryptoService } from '../../crypto/index.js';
import type { Database } from '../../db/client.js';
import {
  attemptBanks,
  attemptQuestions,
  attempts,
  questionBanks,
  questions,
} from '../../db/schema.js';
import { decryptQuestion, decryptTitle } from '../banks/banks.service.js';
import {
  acceptsAnswers,
  elapsedSeconds,
  grade,
  isExpired,
  layOutAttempt,
  letterOf,
  originalOption,
  reorganizeBlanks,
} from './attempt-logic.js';

export type AttemptRow = typeof attempts.$inferSelect;

const INSERT_BATCH = 200;

/** Título de uma tentativa que junta vários simulados. */
export const MULTIPLE_TITLE = 'Múltiplos simulados';

export interface AttemptBank {
  id: string;
  title: string;
}

/** Com um simulado só, o título dele; com vários, "Múltiplos simulados". */
export const attemptTitle = (banks: readonly AttemptBank[]) =>
  banks.length === 1 ? banks[0]!.title : MULTIPLE_TITLE;

export interface StartOptions {
  userId: string;
  /** Um simulado, ou vários para juntar numa prova só (na ordem em que foram escolhidos). */
  bankIds: string[];
  /** Quantas questões sortear; sem valor, todas. */
  count?: number;
  timeLimitSeconds: number | null;
  /** Embaralhar a ordem das questões e das alternativas. */
  shuffled: boolean;
}

/**
 * "Iniciar novo simulado": sorteia, embaralha (se pedido), numera, distribui em páginas de 10 e
 * grava o início com a hora do servidor (e o prazo, se houver tempo limite). Sem embaralhar, as
 * questões seguem a ordem dos simulados escolhidos e, dentro de cada um, a do arquivo.
 */
export async function startAttempt(db: Database, options: StartOptions): Promise<string> {
  const bankOrder = new Map(options.bankIds.map((bankId, index) => [bankId, index]));
  const rows = await db
    .select({ id: questions.id, bankId: questions.bankId, optionCount: questions.optionCount })
    .from(questions)
    .where(inArray(questions.bankId, options.bankIds))
    .orderBy(asc(questions.position));
  rows.sort((a, b) => bankOrder.get(a.bankId)! - bankOrder.get(b.bankId)!);
  const laidOut = layOutAttempt(rows, options.count, options.shuffled);
  const id = uuidv7();
  const startedAt = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(attempts).values({
      id,
      userId: options.userId,
      bankId: options.bankIds.length === 1 ? options.bankIds[0] : null,
      status: 'in_progress',
      totalQuestions: laidOut.length,
      timeLimitSeconds: options.timeLimitSeconds,
      startedAt,
      deadlineAt: options.timeLimitSeconds
        ? new Date(startedAt.getTime() + options.timeLimitSeconds * 1000)
        : null,
    });
    await tx
      .insert(attemptBanks)
      .values(
        options.bankIds.map((bankId, index) => ({ attemptId: id, bankId, position: index + 1 })),
      );
    const values = laidOut.map((question) => ({ attemptId: id, ...question }));
    for (let i = 0; i < values.length; i += INSERT_BATCH) {
      await tx.insert(attemptQuestions).values(values.slice(i, i + INSERT_BATCH));
    }
  });
  return id;
}

/** Tentativa do próprio usuário. A de outra pessoa não é encontrada (a rota responde 404). */
export async function findOwnAttempt(db: Database, userId: string, attemptId: string) {
  const [row] = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.id, attemptId), eq(attempts.userId, userId)))
    .limit(1);
  return row;
}

/**
 * Corrige no servidor e encerra a tentativa. Por tempo esgotado, o fim é o próprio prazo (cobre o
 * navegador fechado). Se ela já estava finalizada, não faz nada: finalizar é idempotente.
 */
export async function finishAttempt(
  db: Database,
  crypto: CryptoService,
  attemptId: string,
  reason: 'user' | 'time',
): Promise<void> {
  await db.transaction(async (tx) => {
    const [attempt] = await tx
      .select()
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .for('update');
    if (!attempt || attempt.status === 'finished') return;

    const rows = await tx
      .select({
        questionId: attemptQuestions.questionId,
        selected: attemptQuestions.selectedOption,
        payloadEnc: questions.payloadEnc,
      })
      .from(attemptQuestions)
      .innerJoin(questions, eq(questions.id, attemptQuestions.questionId))
      .where(eq(attemptQuestions.attemptId, attemptId));
    const answers = rows.map((row) => ({
      questionId: row.questionId,
      selected: row.selected,
      correct: decryptQuestion(crypto, { id: row.questionId, payloadEnc: row.payloadEnc }).correct,
    }));
    const result = grade(answers);
    const correctIds = answers
      .filter((answer) => answer.selected === answer.correct)
      .map((answer) => answer.questionId);

    await tx
      .update(attemptQuestions)
      .set({ isCorrect: false })
      .where(eq(attemptQuestions.attemptId, attemptId));
    if (correctIds.length) {
      await tx
        .update(attemptQuestions)
        .set({ isCorrect: true })
        .where(
          and(
            eq(attemptQuestions.attemptId, attemptId),
            inArray(attemptQuestions.questionId, correctIds),
          ),
        );
    }

    const finishedAt = reason === 'time' && attempt.deadlineAt ? attempt.deadlineAt : new Date();
    await tx
      .update(attempts)
      .set({
        status: 'finished',
        finishedAt,
        finishReason: reason,
        durationSeconds: elapsedSeconds(attempt.startedAt, finishedAt),
        correctCount: result.correct,
        wrongCount: result.wrong,
        blankCount: result.blank,
        score: result.score.toFixed(2),
      })
      .where(eq(attempts.id, attemptId));
  });
}

/** Qualquer acesso a uma tentativa vencida a finaliza. Devolve true se ela está (ou ficou) encerrada. */
export async function settleIfExpired(
  db: Database,
  crypto: CryptoService,
  attempt: AttemptRow,
): Promise<boolean> {
  if (attempt.status === 'finished') return true;
  if (!isExpired(attempt.deadlineAt)) return false;
  await finishAttempt(db, crypto, attempt.id, 'time');
  return true;
}

/** Finaliza as tentativas vencidas do usuário (antes de listar o painel e as tentativas). */
export async function settleExpiredAttempts(db: Database, crypto: CryptoService, userId: string) {
  const expired = await db
    .select({ id: attempts.id })
    .from(attempts)
    .where(
      and(
        eq(attempts.userId, userId),
        eq(attempts.status, 'in_progress'),
        isNotNull(attempts.deadlineAt),
        lte(attempts.deadlineAt, new Date()),
      ),
    );
  for (const { id } of expired) await finishAttempt(db, crypto, id, 'time');
}

export interface AnswerInput {
  number: number;
  /** Letra que o usuário marcou (0 = A). */
  letter: number;
}

/**
 * Grava as respostas. Recusa (accepted = false) se a tentativa já terminou ou se passou do prazo
 * mais a tolerância de 5 s. Devolve também quantas questões estão respondidas e quantas respostas
 * foram ignoradas por apontar uma questão ou uma letra que não existe (a letra E numa questão de 4).
 */
export async function saveAnswers(db: Database, attemptId: string, answers: AnswerInput[]) {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select({ status: attempts.status, deadlineAt: attempts.deadlineAt })
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .for('share');
    if (!attempt || attempt.status !== 'in_progress' || !acceptsAnswers(attempt.deadlineAt)) {
      return { accepted: false, answered: 0, ignored: 0 };
    }

    const rows = await tx
      .select({
        questionId: attemptQuestions.questionId,
        number: attemptQuestions.number,
        optionOrder: attemptQuestions.optionOrder,
        selected: attemptQuestions.selectedOption,
      })
      .from(attemptQuestions)
      .where(eq(attemptQuestions.attemptId, attemptId));
    const byNumber = new Map(rows.map((row) => [row.number, row]));
    const now = new Date();
    let answered = rows.filter((row) => row.selected !== null).length;
    let ignored = 0;

    for (const answer of answers) {
      const row = byNumber.get(answer.number);
      const option = row ? originalOption(row.optionOrder, answer.letter) : null;
      if (!row || option === null) {
        ignored++;
        continue;
      }
      if (option === row.selected) continue;
      await tx
        .update(attemptQuestions)
        .set({ selectedOption: option, answeredAt: now })
        .where(
          and(
            eq(attemptQuestions.attemptId, attemptId),
            eq(attemptQuestions.questionId, row.questionId),
          ),
        );
      if (row.selected === null) answered++;
      row.selected = option;
    }
    return { accepted: true, answered, ignored };
  });
}

/** Questões da tentativa na ordem da prova (sem o conteúdo). */
function listPlacement(db: Database, attemptId: string) {
  return db
    .select({
      questionId: attemptQuestions.questionId,
      number: attemptQuestions.number,
      page: attemptQuestions.page,
      sort: attemptQuestions.sort,
      optionOrder: attemptQuestions.optionOrder,
      selected: attemptQuestions.selectedOption,
    })
    .from(attemptQuestions)
    .where(eq(attemptQuestions.attemptId, attemptId))
    .orderBy(asc(attemptQuestions.sort));
}

export interface ExamQuestion {
  number: number;
  statementHtml: string;
  /** Na ordem embaralhada desta tentativa (A–D, ou A–E com 5 alternativas). */
  options: string[];
  selectedLetter: number | null;
}

export interface ExamPage {
  page: number;
  pageCount: number;
  answered: number;
  total: number;
  questions: ExamQuestion[];
  /** Mapa de questões, de 1 a N. */
  map: { number: number; page: number; answered: boolean }[];
}

/** Uma página da prova. O gabarito não sai daqui: só o enunciado e as alternativas embaralhadas. */
export async function loadExamPage(
  db: Database,
  crypto: CryptoService,
  attemptId: string,
  requestedPage: number,
): Promise<ExamPage> {
  const rows = await listPlacement(db, attemptId);
  const pageCount = Math.max(1, ...rows.map((row) => row.page));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const onPage = rows.filter((row) => row.page === page);
  const payloads = onPage.length
    ? await db
        .select({ id: questions.id, payloadEnc: questions.payloadEnc })
        .from(questions)
        .where(
          inArray(
            questions.id,
            onPage.map((row) => row.questionId),
          ),
        )
    : [];
  const payloadById = new Map(payloads.map((row) => [row.id, decryptQuestion(crypto, row)]));

  return {
    page,
    pageCount,
    answered: rows.filter((row) => row.selected !== null).length,
    total: rows.length,
    questions: onPage.map((row) => {
      const payload = payloadById.get(row.questionId)!;
      return {
        number: row.number,
        statementHtml: payload.statementHtml,
        options: row.optionOrder.map((option) => payload.options[option]!),
        selectedLetter: row.selected === null ? null : letterOf(row.optionOrder, row.selected),
      };
    }),
    map: rows
      .map((row) => ({ number: row.number, page: row.page, answered: row.selected !== null }))
      .sort((a, b) => a.number - b.number),
  };
}

/** Página em que a questão de número `number` está agora. */
export async function pageOfQuestion(db: Database, attemptId: string, number: number) {
  const [row] = await db
    .select({ page: attemptQuestions.page })
    .from(attemptQuestions)
    .where(and(eq(attemptQuestions.attemptId, attemptId), eq(attemptQuestions.number, number)))
    .limit(1);
  return row?.page ?? null;
}

export async function lastPage(db: Database, attemptId: string) {
  const rows = await listPlacement(db, attemptId);
  return Math.max(1, ...rows.map((row) => row.page));
}

/** Números das questões em branco, em ordem. */
export async function listBlankNumbers(db: Database, attemptId: string) {
  const rows = await listPlacement(db, attemptId);
  return rows
    .filter((row) => row.selected === null)
    .map((row) => row.number)
    .sort((a, b) => a - b);
}

/**
 * "Não, responder as em branco": as em branco vão para o final, a partir de uma página nova.
 * Devolve a primeira página das em branco (null se não houver nenhuma).
 */
export async function reorganizeAttempt(db: Database, attemptId: string) {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select({ status: attempts.status })
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .for('update');
    if (attempt?.status !== 'in_progress') return null;

    const rows = await tx
      .select({
        questionId: attemptQuestions.questionId,
        number: attemptQuestions.number,
        page: attemptQuestions.page,
        sort: attemptQuestions.sort,
        selected: attemptQuestions.selectedOption,
      })
      .from(attemptQuestions)
      .where(eq(attemptQuestions.attemptId, attemptId));
    const { placement, firstBlankPage } = reorganizeBlanks(
      rows.map((row) => ({ number: row.number, sort: row.sort, answered: row.selected !== null })),
    );
    for (const row of rows) {
      const target = placement.get(row.number)!;
      if (target.page === row.page && target.sort === row.sort) continue;
      await tx
        .update(attemptQuestions)
        .set(target)
        .where(
          and(
            eq(attemptQuestions.attemptId, attemptId),
            eq(attemptQuestions.questionId, row.questionId),
          ),
        );
    }
    return firstBlankPage;
  });
}

/** Descarta uma tentativa em andamento (as questões dela caem junto, em cascata). */
export async function discardAttempt(db: Database, attemptId: string): Promise<boolean> {
  const [result] = await db
    .delete(attempts)
    .where(and(eq(attempts.id, attemptId), eq(attempts.status, 'in_progress')));
  return result.affectedRows > 0;
}

/** Exclui o relatório: a tentativa finalizada some, com as respostas (em cascata). */
export async function deleteReport(db: Database, attemptId: string): Promise<boolean> {
  const [result] = await db
    .delete(attempts)
    .where(and(eq(attempts.id, attemptId), eq(attempts.status, 'finished')));
  return result.affectedRows > 0;
}

export interface ReportItem {
  number: number;
  /** Simulado de onde a questão veio (aparece quando a prova junta vários). */
  bankId: string;
  statementHtml: string;
  /** Letra e texto da resposta do usuário; null se ficou em branco. */
  selected: { letter: number; html: string } | null;
  correct: { letter: number; html: string };
}

/** Questões erradas e em branco, na ordem dos números, com as letras que o usuário viu. */
export async function loadReportItems(
  db: Database,
  crypto: CryptoService,
  attemptId: string,
): Promise<ReportItem[]> {
  const rows = await db
    .select({
      questionId: attemptQuestions.questionId,
      number: attemptQuestions.number,
      optionOrder: attemptQuestions.optionOrder,
      selected: attemptQuestions.selectedOption,
      bankId: questions.bankId,
      payloadEnc: questions.payloadEnc,
    })
    .from(attemptQuestions)
    .innerJoin(questions, eq(questions.id, attemptQuestions.questionId))
    .where(and(eq(attemptQuestions.attemptId, attemptId), eq(attemptQuestions.isCorrect, false)))
    .orderBy(asc(attemptQuestions.number));

  return rows.map((row) => {
    const payload = decryptQuestion(crypto, { id: row.questionId, payloadEnc: row.payloadEnc });
    const choice = (option: number) => ({
      letter: letterOf(row.optionOrder, option),
      html: payload.options[option]!,
    });
    return {
      number: row.number,
      bankId: row.bankId,
      statementHtml: payload.statementHtml,
      selected: row.selected === null ? null : choice(row.selected),
      correct: choice(payload.correct),
    };
  });
}

/** Quantas questões estão respondidas em cada tentativa. */
async function answeredCounts(db: Database, attemptIds: string[]) {
  if (!attemptIds.length) return new Map<string, number>();
  const rows = await db
    .select({
      attemptId: attemptQuestions.attemptId,
      total: count(attemptQuestions.selectedOption),
    })
    .from(attemptQuestions)
    .where(inArray(attemptQuestions.attemptId, attemptIds))
    .groupBy(attemptQuestions.attemptId);
  return new Map(rows.map((row) => [row.attemptId, row.total]));
}

export interface AttemptSummary {
  id: string;
  bankId: string | null;
  status: AttemptRow['status'];
  totalQuestions: number;
  answered: number;
  startedAt: Date;
  finishedAt: Date | null;
  finishReason: AttemptRow['finishReason'];
  durationSeconds: number | null;
  correctCount: number | null;
  score: string | null;
}

const summaryOf = (row: AttemptRow, answered: Map<string, number>): AttemptSummary => ({
  id: row.id,
  bankId: row.bankId,
  status: row.status,
  totalQuestions: row.totalQuestions,
  answered: answered.get(row.id) ?? 0,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  finishReason: row.finishReason,
  durationSeconds: row.durationSeconds,
  correctCount: row.correctCount,
  score: row.score,
});

/** "Suas tentativas" na página do simulado: as mais recentes primeiro. */
export async function listAttemptsForBank(db: Database, userId: string, bankId: string) {
  const rows = await db
    .select()
    .from(attempts)
    .where(and(eq(attempts.userId, userId), eq(attempts.bankId, bankId)))
    .orderBy(desc(attempts.startedAt));
  const answered = await answeredCounts(
    db,
    rows.filter((row) => row.status === 'in_progress').map((row) => row.id),
  );
  return rows.map((row) => summaryOf(row, answered));
}

/** Simulados de cada tentativa, na ordem escolhida (mesmo os excluídos, para mostrar o nome). */
export async function listAttemptBanks(
  db: Database,
  crypto: CryptoService,
  attemptIds: string[],
): Promise<Map<string, AttemptBank[]>> {
  const byAttempt = new Map<string, AttemptBank[]>();
  if (!attemptIds.length) return byAttempt;
  const rows = await db
    .select({
      attemptId: attemptBanks.attemptId,
      id: questionBanks.id,
      titleEnc: questionBanks.titleEnc,
    })
    .from(attemptBanks)
    .innerJoin(questionBanks, eq(questionBanks.id, attemptBanks.bankId))
    .where(inArray(attemptBanks.attemptId, attemptIds))
    .orderBy(asc(attemptBanks.position));
  const titles = new Map<string, string>();
  for (const row of rows) {
    let title = titles.get(row.id);
    if (title === undefined) {
      title = decryptTitle(crypto, row);
      titles.set(row.id, title);
    }
    byAttempt.set(row.attemptId, [...(byAttempt.get(row.attemptId) ?? []), { id: row.id, title }]);
  }
  return byAttempt;
}

/** Tentativas do usuário, com o título: em andamento e histórico do painel. */
export async function listAttemptsOfUser(db: Database, crypto: CryptoService, userId: string) {
  const rows = await db
    .select()
    .from(attempts)
    .where(eq(attempts.userId, userId))
    .orderBy(desc(attempts.startedAt));
  const answered = await answeredCounts(
    db,
    rows.filter((row) => row.status === 'in_progress').map((row) => row.id),
  );
  const banksOf = await listAttemptBanks(
    db,
    crypto,
    rows.map((row) => row.id),
  );
  const items = rows.map((row) => {
    const banks = banksOf.get(row.id) ?? [];
    return { ...summaryOf(row, answered), title: attemptTitle(banks), banks };
  });
  return {
    inProgress: items.filter((item) => item.status === 'in_progress'),
    history: items
      .filter((item) => item.status === 'finished')
      .sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime()),
  };
}
