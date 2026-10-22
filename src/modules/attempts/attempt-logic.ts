import { randomInt } from 'node:crypto';

// Regras da prova que não dependem do banco: sorteio, embaralhamento, páginas, reorganização das
// questões em branco, correção e nota (seções 5.8 a 5.12 do plano).

export const PAGE_SIZE = 10;
/** Tolerância para a rede: resposta que chega até 5 s depois do prazo ainda é aceita. */
export const DEADLINE_GRACE_MS = 5_000;

export const pageOf = (index: number) => Math.floor(index / PAGE_SIZE) + 1;

/** Fisher-Yates com números aleatórios do sistema. Não altera a lista recebida. */
export function shuffle<T>(items: readonly T[], random = randomInt): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export interface LaidOutQuestion {
  questionId: string;
  /** Número exibido (1..N); não muda mais. */
  number: number;
  page: number;
  sort: number;
  /** optionOrder[letra] = índice original da alternativa. [2,0,3,1]: a letra A mostra a 2. */
  optionOrder: number[];
}

export interface QuestionToLayOut {
  id: string;
  /** Quantas alternativas a questão tem (4 ou 5). */
  optionCount: number;
}

/**
 * Monta uma tentativa nova: sorteia `count` questões (todas, se não informado), numera de 1 a N e
 * distribui em páginas de 10. Embaralhando, a ordem das questões e das alternativas muda; sem
 * embaralhar, as sorteadas ficam na ordem recebida e as alternativas na ordem do arquivo.
 */
export function layOutAttempt(
  pool: readonly QuestionToLayOut[],
  count = pool.length,
  shuffled = true,
  random = randomInt,
): LaidOutQuestion[] {
  const drawn = shuffle(pool, random).slice(0, count);
  const kept = new Set(drawn);
  const chosen = shuffled ? drawn : pool.filter((question) => kept.has(question));
  return chosen.map((question, index) => {
    const original = Array.from({ length: question.optionCount }, (_, i) => i);
    return {
      questionId: question.id,
      number: index + 1,
      page: pageOf(index),
      sort: index + 1,
      optionOrder: shuffled ? shuffle(original, random) : original,
    };
  });
}

export interface PlacedQuestion {
  number: number;
  sort: number;
  answered: boolean;
}

/**
 * "Não, responder as em branco" (seção 5.10): as respondidas continuam primeiro, na ordem em que
 * estavam; as em branco vão para o final, começando numa página nova. Os números não mudam.
 * Devolve a nova página e a nova ordem de cada questão, e a primeira página das em branco.
 */
export function reorganizeBlanks(questions: readonly PlacedQuestion[]) {
  const ordered = [...questions].sort((a, b) => a.sort - b.sort);
  const answered = ordered.filter((question) => question.answered);
  const blank = ordered.filter((question) => !question.answered);
  const answeredPages = Math.ceil(answered.length / PAGE_SIZE);

  const placement = new Map<number, { page: number; sort: number }>();
  answered.forEach((question, index) => {
    placement.set(question.number, { page: pageOf(index), sort: index + 1 });
  });
  blank.forEach((question, index) => {
    placement.set(question.number, {
      page: answeredPages + pageOf(index),
      sort: answered.length + index + 1,
    });
  });
  return { placement, firstBlankPage: blank.length ? answeredPages + 1 : null };
}

/** A letra que o usuário viu (0 = A) vira o índice original da alternativa. */
export function originalOption(optionOrder: readonly number[], letter: number): number | null {
  const option = optionOrder[letter];
  return Number.isInteger(letter) && option !== undefined ? option : null;
}

/** O índice original vira a letra que o usuário viu nesta tentativa (0 = A). */
export function letterOf(optionOrder: readonly number[], option: number): number {
  return optionOrder.indexOf(option);
}

export const letterLabel = (letter: number) => String.fromCharCode(65 + letter);

export interface Grade {
  correct: number;
  /** Já inclui as em branco. */
  wrong: number;
  blank: number;
  total: number;
  /** 0 a 10, com 2 casas. */
  score: number;
}

/** Correção: a resposta guardada é o índice original, comparado direto com o gabarito. */
export function grade(answers: readonly { selected: number | null; correct: number }[]): Grade {
  const total = answers.length;
  const correct = answers.filter((answer) => answer.selected === answer.correct).length;
  const blank = answers.filter((answer) => answer.selected === null).length;
  return { correct, wrong: total - correct, blank, total, score: scoreOf(correct, total) };
}

/** Nota = acertos ÷ total × 10, com 2 casas (7 de 9 dá 7,78). */
export function scoreOf(correct: number, total: number): number {
  return total ? Math.round((correct * 1000) / total) / 100 : 0;
}

/** Até quando uma resposta é aceita. Sem tempo limite, sempre. */
export function acceptsAnswers(deadlineAt: Date | null, now = new Date()): boolean {
  return !deadlineAt || now.getTime() <= deadlineAt.getTime() + DEADLINE_GRACE_MS;
}

export function isExpired(deadlineAt: Date | null, now = new Date()): boolean {
  return Boolean(deadlineAt) && now.getTime() >= deadlineAt!.getTime();
}

export const elapsedSeconds = (from: Date, to: Date) =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
