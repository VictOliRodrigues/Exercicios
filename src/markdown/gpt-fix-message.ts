import type { ImportIssue } from './parse-questions.js';

const FORMAT_RULES = [
  '- # Título na primeira linha;',
  '- cada questão começa com ## Questão N;',
  '- enunciado, linha em branco e 4 alternativas no formato - [ ] texto, com a correta como - [x] texto;',
  '- nada de HTML, imagens ou texto depois das alternativas.',
];

/**
 * Mensagem pronta para colar no ChatGPT. Ele não enxerga números de linha, então cada problema
 * traz o número da questão e o começo do enunciado.
 */
export function buildGptFixMessage(issues: ImportIssue[]): string {
  const problems = issues.map((issue, index) => {
    if (issue.question === null) return `${index + 1}. ${issue.gptDetail}`;
    const excerpt = issue.excerpt ? ` ("${issue.excerpt}")` : '';
    return `${index + 1}. Questão ${issue.question}${excerpt}: ${issue.gptDetail}`;
  });

  return [
    'O arquivo .md que você gerou não pôde ser importado no sistema de simulados. Problemas encontrados:',
    '',
    ...problems,
    '',
    'Corrija apenas esses problemas, sem alterar as outras questões, e me envie novamente o arquivo .md COMPLETO, com todas as questões, seguindo as mesmas regras de formato:',
    ...FORMAT_RULES,
  ].join('\n');
}
