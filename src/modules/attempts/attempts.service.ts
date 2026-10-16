import { and, asc, count, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { CryptoService } from '../../crypto/index.js';
import type { Database } from '../../db/client.js';
import { attemptQuestions, attempts, questionBanks, questions } from '../../db/schema.js';
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

export interface StartOptions {
  userId: string;
  bankId: string;
  /** Quantas questões sortear; sem valor, todas. */
  count?: number;
  timeLimitSeconds: number | null;
}

/**
 * "Iniciar novo simulado": sorteia, embaralha questões e alternativas, numera, distribui em
 * páginas de 10 e grava o início com a hora do servidor (e o prazo, se houver tempo limite).
 */
export async function startAttempt(db: Database, options: StartOptions): Promise<string> {
  const rows = await db
    .select({ id: questions.id })
    .from(questions)
    .where(eq(questions.bankId, options.bankId))
    .orderBy(asc(questions.position));
  const laidOut = layOutAttempt(
    rows.map((row) => row.id),
    options.count,
  );
  const id = uuidv7();
  const startedAt = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(attempts).values({
      id,
      userId: options.userId,
      bankId: options.bankId,
      status: 'in_progress',
      totalQuestions: laidOut.length,
      timeLimitSeconds: options.timeLimitSeconds,
      startedAt,
      deadlineAt: options.timeLimitSeconds
        ? new Date(startedAt.getTime() + options.timeLimitSeconds * 1000)
        : null,
    });
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
 * mais a tolerância de 5 s. Devolve também quantas questões estão respondidas.
 */
export async function saveAnswers(db: Database, attemptId: string, answers: AnswerInput[]) {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .select({ status: attempts.status, deadlineAt: attempts.deadlineAt })
      .from(attempts)
      .where(eq(attempts.id, attemptId))
      .for('share');
    if (!attempt || attempt.status !== 'in_progress' || !acceptsAnswers(attempt.deadlineAt)) {
      return { accepted: false, answered: 0 };
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

    for (const answer of answers) {
      const row = byNumber.get(answer.number);
      const option = row ? originalOption(row.optionOrder, answer.letter) : null;
      if (!row || option === null || option === row.selected) continue;
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
    return { accepted: true, answered };
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
  /** Na ordem embaralhada desta tentativa (A–D). */
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

export interface ReportItem {
  number: number;
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
  bankId: string;
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

/** Tentativas do usuário, com o título do simulado: em andamento e histórico do painel. */
export async function listAttemptsOfUser(db: Database, crypto: CryptoService, userId: string) {
  const rows = await db
    .select({ attempt: attempts, bankId: questionBanks.id, titleEnc: questionBanks.titleEnc })
    .from(attempts)
    .innerJoin(questionBanks, eq(questionBanks.id, attempts.bankId))
    .where(eq(attempts.userId, userId))
    .orderBy(desc(attempts.startedAt));
  const answered = await answeredCounts(
    db,
    rows.filter((row) => row.attempt.status === 'in_progress').map((row) => row.attempt.id),
  );
  const titles = new Map<string, string>();
  const titleOf = (row: { bankId: string; titleEnc: string }) => {
    let title = titles.get(row.bankId);
    if (title === undefined) {
      title = decryptTitle(crypto, { id: row.bankId, titleEnc: row.titleEnc });
      titles.set(row.bankId, title);
    }
    return title;
  };
  const items = rows.map((row) => ({ ...summaryOf(row.attempt, answered), title: titleOf(row) }));
  return {
    inProgress: items.filter((item) => item.status === 'in_progress'),
    history: items
      .filter((item) => item.status === 'finished')
      .sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime()),
  };
}
