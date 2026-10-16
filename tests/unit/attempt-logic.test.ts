import { describe, expect, it } from 'vitest';
import {
  acceptsAnswers,
  grade,
  isExpired,
  layOutAttempt,
  letterLabel,
  letterOf,
  originalOption,
  reorganizeBlanks,
  scoreOf,
  shuffle,
  type PlacedQuestion,
} from '../../src/modules/attempts/attempt-logic.js';
import { formatClock, formatDuration, formatPercent, formatScore } from '../../src/http/format.js';

const ids = (count: number) => Array.from({ length: count }, (_, i) => `q${i + 1}`);

/** Tamanho de cada página, na ordem: [10, 8, 7]. */
function pageSizes(placement: Map<number, { page: number }>) {
  const sizes = new Map<number, number>();
  for (const { page } of placement.values()) sizes.set(page, (sizes.get(page) ?? 0) + 1);
  return [...sizes.entries()].sort((a, b) => a[0] - b[0]).map(([, size]) => size);
}

/** Prova de N questões na ordem 1..N; `blank` lista os números em branco. */
const examWith = (total: number, blank: number[]): PlacedQuestion[] =>
  Array.from({ length: total }, (_, i) => ({
    number: i + 1,
    sort: i + 1,
    answered: !blank.includes(i + 1),
  }));

describe('embaralhamento e montagem da tentativa', () => {
  it('shuffle devolve uma permutação sem alterar a lista original', () => {
    const items = ids(30);
    const copy = [...items];
    const result = shuffle(items);
    expect(items).toEqual(copy);
    expect([...result].sort()).toEqual([...items].sort());
  });

  it('25 questões geram 3 páginas (10/10/5), numeradas de 1 a 25', () => {
    const laidOut = layOutAttempt(ids(25));
    expect(laidOut.map((q) => q.number)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(laidOut.map((q) => q.sort)).toEqual(laidOut.map((q) => q.number));
    expect(pageSizes(new Map(laidOut.map((q) => [q.number, q])))).toEqual([10, 10, 5]);
    expect(new Set(laidOut.map((q) => q.questionId)).size).toBe(25);
    for (const q of laidOut) expect([...q.optionOrder].sort()).toEqual([0, 1, 2, 3]);
  });

  it('sorteia um número menor de questões, sem repetir', () => {
    const laidOut = layOutAttempt(ids(25), 7);
    expect(laidOut).toHaveLength(7);
    expect(new Set(laidOut.map((q) => q.questionId)).size).toBe(7);
    expect(laidOut.every((q) => q.page === 1)).toBe(true);
  });

  it('embaralha de verdade: a ordem das questões e das alternativas varia', () => {
    const orders = new Set<string>();
    const options = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const laidOut = layOutAttempt(ids(25));
      orders.add(laidOut.map((q) => q.questionId).join());
      options.add(laidOut[0]!.optionOrder.join());
    }
    expect(orders.size).toBeGreaterThan(1);
    expect(options.size).toBeGreaterThan(1);
  });

  it('sem embaralhar: questões na ordem recebida e alternativas na ordem do arquivo', () => {
    const all = layOutAttempt(ids(25), 25, false);
    expect(all.map((q) => q.questionId)).toEqual(ids(25));
    expect(all.every((q) => q.optionOrder.join() === '0,1,2,3')).toBe(true);

    // Sorteando menos, quais entram varia, mas elas continuam na ordem do arquivo.
    const drawn = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const sampled = layOutAttempt(ids(25), 7, false).map((q) => q.questionId);
      expect(sampled).toHaveLength(7);
      expect(sampled).toEqual([...sampled].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
      drawn.add(sampled.join());
    }
    expect(drawn.size).toBeGreaterThan(1);
  });

  it('usa o gerador recebido (ordem previsível nos testes)', () => {
    // random sempre 0: cada passo troca o último com o primeiro.
    expect(shuffle([1, 2, 3, 4], () => 0)).toEqual([2, 3, 4, 1]);
  });
});

describe('alternativas embaralhadas', () => {
  it('a correção segue certa com qualquer option_order', () => {
    const correct = 2;
    const orders = [
      [0, 1, 2, 3],
      [2, 0, 3, 1],
      [3, 2, 1, 0],
      [1, 3, 0, 2],
    ];
    for (const order of orders) {
      const letterOfCorrect = letterOf(order, correct);
      // Marcar a letra que mostra a alternativa correta acerta; qualquer outra erra.
      for (let letter = 0; letter < 4; letter++) {
        const selected = originalOption(order, letter);
        expect(selected === correct).toBe(letter === letterOfCorrect);
      }
    }
  });

  it('o relatório mostra a letra que o usuário viu', () => {
    const order = [2, 0, 3, 1];
    expect(letterLabel(letterOf(order, 2))).toBe('A');
    expect(letterLabel(letterOf(order, 1))).toBe('D');
    expect(originalOption(order, 4)).toBeNull();
    expect(originalOption(order, 1.5)).toBeNull();
  });
});

describe('reorganização das questões em branco', () => {
  it('25 questões com 7 em branco: páginas 10/8/7, em branco a partir da página 3', () => {
    const blank = [3, 8, 12, 15, 19, 21, 24];
    const { placement, firstBlankPage } = reorganizeBlanks(examWith(25, blank));
    expect(pageSizes(placement)).toEqual([10, 8, 7]);
    expect(firstBlankPage).toBe(3);
    for (const number of blank) expect(placement.get(number)!.page).toBe(3);
  });

  it('12 respondidas e 13 em branco: páginas 10/2/10/3', () => {
    const blank = [1, 2, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23];
    const { placement, firstBlankPage } = reorganizeBlanks(examWith(25, blank));
    expect(pageSizes(placement)).toEqual([10, 2, 10, 3]);
    expect(firstBlankPage).toBe(3);
  });

  it('respondidas mantêm a ordem; em branco vão para o final na ordem em que estavam', () => {
    // Ordem atual da prova diferente dos números (como depois de uma reorganização anterior).
    const exam: PlacedQuestion[] = [
      { number: 4, sort: 1, answered: true },
      { number: 1, sort: 2, answered: false },
      { number: 3, sort: 3, answered: true },
      { number: 2, sort: 4, answered: false },
    ];
    const { placement } = reorganizeBlanks(exam);
    const order = [...placement.entries()]
      .sort((a, b) => a[1].sort - b[1].sort)
      .map(([number]) => number);
    expect(order).toEqual([4, 3, 1, 2]);
    // Os números não mudam: só a página e a ordem.
    expect([...placement.keys()].sort()).toEqual([1, 2, 3, 4]);
    expect(placement.get(1)!.page).toBe(2);
  });

  it('sem respondidas, as em branco começam na página 1; sem em branco, nada muda', () => {
    expect(
      reorganizeBlanks(
        examWith(
          12,
          ids(12).map((_, i) => i + 1),
        ),
      ).firstBlankPage,
    ).toBe(1);
    const none = reorganizeBlanks(examWith(12, []));
    expect(none.firstBlankPage).toBeNull();
    expect(pageSizes(none.placement)).toEqual([10, 2]);
  });
});

describe('nota', () => {
  const answers = (right: number, wrong: number, blank: number) => [
    ...Array.from({ length: right }, () => ({ selected: 1, correct: 1 })),
    ...Array.from({ length: wrong }, () => ({ selected: 0, correct: 1 })),
    ...Array.from({ length: blank }, () => ({ selected: null, correct: 1 })),
  ];

  it('0 de 10 dá 0 e 10 de 10 dá 10', () => {
    expect(grade(answers(0, 10, 0)).score).toBe(0);
    expect(grade(answers(10, 0, 0)).score).toBe(10);
    expect(formatScore(grade(answers(10, 0, 0)).score)).toBe('10,0');
    expect(formatScore('0.00')).toBe('0,0');
  });

  it('7 de 10 dá 7,0 e 7 de 9 dá 7,78 (exibida como 7,8)', () => {
    expect(scoreOf(7, 10)).toBe(7);
    expect(formatScore(scoreOf(7, 10))).toBe('7,0');
    expect(scoreOf(7, 9)).toBe(7.78);
    expect(formatScore('7.78')).toBe('7,8');
    expect(formatScore('7.85')).toBe('7,9');
    expect(formatScore('7.84')).toBe('7,8');
  });

  it('em branco conta como errada', () => {
    const result = grade(answers(6, 2, 2));
    expect(result).toEqual({ correct: 6, wrong: 4, blank: 2, total: 10, score: 6 });
  });

  it('percentual de acerto', () => {
    expect(formatPercent(7, 9)).toBe('77,8%');
    expect(formatPercent(7, 10)).toBe('70%');
  });
});

describe('tempo', () => {
  it('formata o cronômetro e a duração', () => {
    expect(formatClock(0)).toBe('00:00:00');
    expect(formatClock(3725)).toBe('01:02:05');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(754)).toBe('12 min 34 s');
    expect(formatDuration(1800)).toBe('30 min');
    expect(formatDuration(3725)).toBe('1 h 2 min 5 s');
    expect(formatDuration(0)).toBe('0 s');
  });

  it('aceita resposta até 5 s depois do prazo; o prazo vence na hora exata', () => {
    const deadline = new Date('2026-10-15T12:00:00.000Z');
    const at = (ms: number) => new Date(deadline.getTime() + ms);
    expect(acceptsAnswers(null)).toBe(true);
    expect(acceptsAnswers(deadline, at(5_000))).toBe(true);
    expect(acceptsAnswers(deadline, at(5_001))).toBe(false);
    expect(isExpired(null)).toBe(false);
    expect(isExpired(deadline, at(-1))).toBe(false);
    expect(isExpired(deadline, at(0))).toBe(true);
  });
});
