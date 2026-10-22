import { describe, expect, it } from 'vitest';
import { buildGptFixMessage } from '../../src/markdown/gpt-fix-message.js';
import { parseQuestions } from '../../src/markdown/parse-questions.js';

describe('mensagem para o ChatGPT', () => {
  it('cita o número da questão e o começo do enunciado, e repete as regras do formato', () => {
    const md = [
      '## Questão 1',
      'Qual é a função do método map em um array de JavaScript?',
      '',
      '- [ ] a',
      '- [x] b',
      '- [ ] c',
      '',
      '## Questão 2',
      'Sobre o protocolo HTTP:',
      '',
      '- [ ] a',
      '- [ ] b',
      '- [ ] c',
      '- [ ] Todas as anteriores',
    ].join('\n');
    const message = buildGptFixMessage(parseQuestions(md).errors);

    expect(message).toBe(
      [
        'O arquivo .md que você gerou não pôde ser importado no sistema de simulados. Problemas encontrados:',
        '',
        '1. Questão 1 ("Qual é a função do método map em um…"): tem 3 alternativas; precisa ter 4 ou 5.',
        '2. Questão 2 ("Sobre o protocolo HTTP:"): nenhuma alternativa marcada como correta; marque exatamente uma com - [x].',
        '3. Questão 2 ("Sobre o protocolo HTTP:"): a alternativa "Todas as anteriores" depende da ordem, mas o sistema embaralha as alternativas; troque por outra.',
        '',
        'Corrija apenas esses problemas, sem alterar as outras questões, e me envie novamente o arquivo .md COMPLETO, com todas as questões, seguindo as mesmas regras de formato:',
        '- # Título na primeira linha;',
        '- cada questão começa com ## Questão N;',
        '- enunciado, linha em branco e 4 ou 5 alternativas no formato - [ ] texto, com a correta como - [x] texto;',
        '- nada de HTML, imagens ou texto depois das alternativas.',
      ].join('\n'),
    );
    expect(message).not.toMatch(/linha \d/);
  });

  it('questão sem enunciado aparece só com o número', () => {
    const message = buildGptFixMessage(
      parseQuestions('## Questão 4\n\n- [ ] a\n- [x] b\n- [ ] c\n- [ ] d\n').errors,
    );
    expect(message).toContain(
      '1. Questão 1: está sem enunciado; escreva o enunciado entre a linha ## e as alternativas.',
    );
  });

  it('arquivo sem questões', () => {
    const message = buildGptFixMessage(parseQuestions('Só texto.').errors);
    expect(message).toContain(
      '1. Nenhuma questão foi encontrada: cada questão precisa começar com uma linha ## Questão N.',
    );
  });
});
