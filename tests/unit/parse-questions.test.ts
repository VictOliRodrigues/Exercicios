import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  dependsOnOrder,
  describeIssue,
  parseQuestions,
} from '../../src/markdown/parse-questions.js';

const MODEL = readFileSync('modelos/modelo-questoes.md', 'utf8');

/** Monta uma questão no formato padrão. `options` usa "x" para marcar a correta. */
function question(statement: string, options: [string, string][]) {
  const lines = options.map(([mark, text]) => `- [${mark}] ${text}`);
  return `## Questão\n${statement}\n\n${lines.join('\n')}\n`;
}

const FOUR: [string, string][] = [
  [' ', 'um'],
  ['x', 'dois'],
  [' ', 'três'],
  [' ', 'quatro'],
];

const messages = (markdown: string) => parseQuestions(markdown).errors.map(describeIssue);

describe('parser de questões', () => {
  it('aceita o modelo inteiro', () => {
    const result = parseQuestions(MODEL);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.title).toBe('Modelo de simulado');
    expect(result.questions).toHaveLength(5);
    expect(result.questions.map((q) => q.correct)).toEqual([2, 1, 1, 2, 0]);
    expect(result.questions.map((q) => q.sourceLine)).toEqual([3, 12, 20, 35, 49]);
    expect(result.questions.map((q) => q.optionsHtml.length)).toEqual([5, 4, 4, 4, 4]);
  });

  it('gera HTML com código, listas e tabelas, e alternativas sem <p> em volta', () => {
    const [, q2, q3, q4, q5] = parseQuestions(MODEL).questions;
    expect(q2!.optionsHtml[1]).toBe(
      'Trocando <code>[ ]</code> por <code>[x]</code> no início da alternativa.',
    );
    expect(q3!.statementHtml).toContain('<pre><code class="language-js">');
    expect(q4!.statementHtml).toContain(
      '<li>II. Uma questão pode ter mais de uma alternativa correta.</li>',
    );
    expect(q5!.statementHtml).toContain('<table>');
  });

  it('numera as questões pela ordem, sem depender do texto do ##', () => {
    const md =
      '## Questão 7\nA?\n\n- [x] a\n- [ ] b\n- [ ] c\n- [ ] d\n\n' +
      '## Questão 2\nB?\n\n- [ ] a\n- [x] b\n- [ ] c\n- [ ] d\n';
    const result = parseQuestions(md);
    expect(result.errors).toEqual([]);
    expect(result.questions.map((q) => q.position)).toEqual([1, 2]);
  });

  it('aceita 4 ou 5 alternativas, misturadas no mesmo arquivo', () => {
    const five = question('Cinco?', [...FOUR, [' ', 'cinco']]);
    const result = parseQuestions(`# T\n\n${question('Quatro?', FOUR)}\n${five}`);
    expect(result.errors).toEqual([]);
    expect(result.questions.map((q) => q.optionsHtml)).toEqual([
      ['um', 'dois', 'três', 'quatro'],
      ['um', 'dois', 'três', 'quatro', 'cinco'],
    ]);
  });

  it('acusa 3 ou 6 alternativas', () => {
    const three = question('Três?', FOUR.slice(0, 3));
    const six = question('Seis?', [...FOUR, [' ', 'cinco'], [' ', 'seis']]);
    expect(messages(`# T\n\n${three}\n${six}`)).toEqual([
      'Questão 1 (linha 6): encontrei 3 alternativas, esperado 4 ou 5.',
      'Questão 2 (linha 13): encontrei 6 alternativas, esperado 4 ou 5.',
    ]);
  });

  it('acusa nenhuma ou duas alternativas corretas', () => {
    const none = question('Nenhuma?', [
      [' ', 'a'],
      [' ', 'b'],
      [' ', 'c'],
      [' ', 'd'],
    ]);
    const two = question('Duas?', [
      ['x', 'a'],
      ['X', 'b'],
      [' ', 'c'],
      [' ', 'd'],
    ]);
    expect(messages(none + '\n' + two)).toEqual([
      'Questão 1 (linha 4): nenhuma alternativa marcada como correta.',
      'Questão 2 (linha 12): 2 alternativas marcadas como corretas.',
    ]);
  });

  it('acusa enunciado vazio quando o ## só tem o número', () => {
    const md = '## Questão 9\n\n- [ ] a\n- [x] b\n- [ ] c\n- [ ] d\n';
    expect(messages(md)).toEqual(['Questão 1 (linha 1): enunciado vazio.']);
  });

  it('usa o texto do ## como enunciado quando não há nada entre ele e as alternativas', () => {
    const md =
      '## Questão 1: Qual é a capital da **França**?\n- [ ] Roma\n- [x] Paris\n- [ ] Berlim\n- [ ] Madri\n';
    const result = parseQuestions(md);
    expect(result.errors).toEqual([]);
    expect(result.questions[0]!.statementHtml).toBe(
      '<p>Qual é a capital da <strong>França</strong>?</p>',
    );
  });

  it('acusa alternativas que dependem da ordem', () => {
    const md = question('Qual?', [
      [' ', 'Lisboa'],
      [' ', 'Porto'],
      ['x', 'Todas as anteriores'],
      [' ', 'Nenhuma das alternativas acima'],
    ]);
    expect(messages(md)).toEqual([
      'Questão 1 (linha 6): a alternativa "Todas as anteriores" depende da ordem.',
      'Questão 1 (linha 7): a alternativa "Nenhuma das alternativas acima" depende da ordem.',
    ]);
  });

  it('distingue referência à ordem de texto comum', () => {
    for (const text of [
      'Todas as anteriores',
      'nenhuma das anteriores',
      'Alternativas A e B',
      'As alternativas B e D estão corretas',
      'Letra C',
      'A alternativa anterior',
      'Ambas as anteriores',
    ]) {
      expect(dependsOnOrder(text), text).toBe(true);
    }
    for (const text of [
      'I e III, apenas.',
      'A',
      'Os três tiveram a mesma nota.',
      'Uma alternativa a esse método é usar map.',
      'Todas as afirmativas estão corretas.',
      'Nenhuma das linguagens citadas no enunciado',
    ]) {
      expect(dependsOnOrder(text), text).toBe(false);
    }
  });

  it('não confunde - [x] dentro de bloco de código com alternativa', () => {
    const md =
      '## Q\nVeja:\n\n```md\n- [x] isto é código\n- [ ] também\n```\n\n- [ ] a\n- [x] b\n- [ ] c\n- [ ] d\n';
    const result = parseQuestions(md);
    expect(result.errors).toEqual([]);
    expect(result.questions[0]!.correct).toBe(1);
    expect(result.questions[0]!.statementHtml).toContain('- [x] isto é código');
  });

  it('separa a lista comum colada nas alternativas', () => {
    const md =
      '## Q\nAnalise:\n\n- I. um\n- II. dois\n- [ ] I\n- [x] II\n- [ ] I e II\n- [ ] nenhuma\n';
    const result = parseQuestions(md);
    expect(result.errors).toEqual([]);
    const [q] = result.questions;
    expect(q!.statementHtml).toContain('<li>I. um</li>');
    expect(q!.statementHtml).toContain('<li>II. dois</li>');
    expect(q!.optionsHtml).toEqual(['I', 'II', 'I e II', 'nenhuma']);
    expect(q!.correct).toBe(1);
  });

  it('aceita CRLF, BOM e marcadores *, + e -', () => {
    const md =
      '﻿# Título\r\n\r\n## Q\r\nEnunciado\r\n\r\n* [ ] a\r\n* [x] b\r\n* [ ] c\r\n* [ ] d\r\n\r\n## Q2\r\nOutro\r\n\r\n+ [ ] a\r\n+ [ ] b\r\n+ [ ] c\r\n+ [x] d\r\n';
    const result = parseQuestions(md);
    expect(result.errors).toEqual([]);
    expect(result.title).toBe('Título');
    expect(result.questions.map((q) => q.correct)).toEqual([1, 3]);
  });

  it('remove HTML cru e gera aviso', () => {
    const md =
      '## Q\n<script>alert("bloco")</script>\n\nTexto <img src=x onerror="alert(1)"> com <b>tag</b> e [link](javascript:alert(1)).\n\n- [ ] a<script>alert(2)</script>\n- [x] b\n- [ ] c\n- [ ] d\n';
    const result = parseQuestions(md);
    expect(result.errors).toEqual([]);
    const [q] = result.questions;
    const html = q!.statementHtml + q!.optionsHtml.join('');
    expect(html).not.toMatch(/<script|<img|onerror|javascript:|<b>|href/i);
    expect(q!.statementHtml).toBe('<p>Texto  com tag e link.</p>');
    expect(result.warnings).toEqual(['Questão 1: o HTML foi removido.']);
  });

  it('avisa sobre texto antes da 1ª questão e depois das alternativas', () => {
    const md = `Aqui estão as questões:\n\n# Título\n\n${question('Q?', FOUR)}\n**Gabarito:** dois\n\n---\n\n${question('R?', FOUR)}\n---\n`;
    const result = parseQuestions(md);
    expect(result.errors).toEqual([]);
    expect(result.title).toBe('Título');
    expect(result.warnings).toEqual([
      'O texto antes da 1ª questão foi ignorado.',
      'Questão 1: o texto depois das alternativas foi ignorado.',
    ]);
  });

  it('acusa arquivo sem nenhuma questão', () => {
    expect(messages('# Só o título\n\nTexto solto.\n')).toEqual([
      'Nenhuma questão encontrada (cada questão começa com ##).',
    ]);
    expect(messages('')).toEqual(['Nenhuma questão encontrada (cada questão começa com ##).']);
  });

  it('acusa questão sem lista de alternativas', () => {
    expect(messages('## Q\nQual?\n\nA) um\nB) dois\n')).toEqual([
      'Questão 1 (linha 1): nenhuma alternativa encontrada (as alternativas são uma lista no formato - [ ] texto).',
    ]);
  });

  it('acusa imagem, alternativa sem marcação e alternativas repetidas', () => {
    const md = '## Q\nVeja ![grafico](http://x/y.png)\n\n- [ ] a\n- b\n- [x] c\n- [ ] A\n';
    expect(messages(md)).toEqual([
      'Questão 1 (linha 5): a alternativa "b" não começa com [ ] ou [x].',
      'Questão 1 (linha 7): a alternativa "A" aparece repetida.',
      'Questão 1 (linha 1): tem imagem, e imagens não são suportadas.',
    ]);
  });

  it('junta os erros de todas as questões e não devolve as questões com erro', () => {
    const md = question('Boa', FOUR) + '\n' + question('Ruim', FOUR.slice(0, 2));
    const result = parseQuestions(md);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.question).toBe(2);
    expect(result.questions.map((q) => q.position)).toEqual([1]);
  });
});
