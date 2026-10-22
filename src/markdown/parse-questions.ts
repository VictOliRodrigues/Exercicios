import type { Heading, List, ListItem, Nodes, PhrasingContent, RootContent } from 'mdast';
import { parseMarkdown, renderInline, renderNodes } from './render.js';

/** Cada questão tem 4 ou 5 alternativas (A–D ou A–E); o arquivo pode misturar as duas. */
export const MIN_OPTIONS = 4;
export const MAX_OPTIONS = 5;
const OPTIONS_LABEL = `${MIN_OPTIONS} ou ${MAX_OPTIONS}`;
const TITLE_MAX_LENGTH = 200;
const EXCERPT_LENGTH = 40;

export interface ParsedQuestion {
  /** Ordem no arquivo (1..N). */
  position: number;
  sourceLine: number | null;
  statementHtml: string;
  optionsHtml: string[];
  /** Índice da alternativa correta (0..3, ou 0..4 com 5 alternativas), na ordem do arquivo. */
  correct: number;
}

/**
 * Um problema que impede a importação. `detail` é a explicação para o usuário e `gptDetail` é a
 * instrução de correção que vai na mensagem para o ChatGPT (que não enxerga números de linha).
 */
export interface ImportIssue {
  question: number | null;
  line: number | null;
  excerpt: string | null;
  detail: string;
  gptDetail: string;
}

export interface ParseResult {
  title: string | null;
  questions: ParsedQuestion[];
  errors: ImportIssue[];
  warnings: string[];
}

/** "Questão 3 (linha 27): encontrei 3 alternativas, esperado 4 ou 5." */
export function describeIssue(issue: ImportIssue): string {
  if (issue.question === null) return issue.detail;
  const where = issue.line === null ? '' : ` (linha ${issue.line})`;
  return `Questão ${issue.question}${where}: ${issue.detail}`;
}

const isQuestionHeading = (node: RootContent): node is Heading =>
  node.type === 'heading' && node.depth === 2;

const isTask = (item: ListItem) => typeof item.checked === 'boolean';

// Separadores e definições não contam como texto (o ChatGPT costuma pôr --- entre as questões).
const isSilent = (node: RootContent) =>
  node.type === 'thematicBreak' || node.type === 'definition' || node.type === 'footnoteDefinition';

const lineOf = (node: Nodes) => node.position?.start.line ?? null;

// Filhos destes nós são blocos: o texto de cada um ganha um espaço, para "I. um" e "II. dois" não
// virarem "I. umII. dois".
const BLOCK_PARENTS = new Set(['root', 'list', 'listItem', 'blockquote', 'table', 'tableRow']);

function textOf(node: Nodes): string {
  if (node.type === 'html') return '';
  if ('value' in node) return node.value;
  if (!('children' in node)) return '';
  const children = node.children as Nodes[];
  return children.map(textOf).join(BLOCK_PARENTS.has(node.type) ? ' ' : '');
}

const plainText = (nodes: Nodes[]) => nodes.map(textOf).join(' ').replace(/\s+/g, ' ').trim();

/** Corta no último espaço antes do limite, para não partir uma palavra ao meio. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const excerptOf = (text: string) => (text ? truncate(text, EXCERPT_LENGTH) : null);

interface CleanupFlags {
  html: boolean;
  image: boolean;
}

/**
 * Remove o que não pode ir para a prova: HTML cru (sinalizado para virar aviso), imagens
 * (sinalizadas para virar erro), links (fica só o texto, para ninguém sair da prova sem querer)
 * e notas de rodapé.
 */
function cleanNodes<T extends Nodes>(nodes: T[], flags: CleanupFlags): T[] {
  const result: Nodes[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'html':
        if (!node.value.trim().startsWith('<!--')) flags.html = true;
        continue;
      case 'image':
      case 'imageReference':
        flags.image = true;
        continue;
      case 'definition':
      case 'footnoteDefinition':
      case 'footnoteReference':
      case 'thematicBreak':
        continue;
      case 'link':
      case 'linkReference':
        result.push(...cleanNodes(node.children, flags));
        continue;
    }
    if ('children' in node) {
      result.push({ ...node, children: cleanNodes(node.children as Nodes[], flags) } as Nodes);
    } else {
      result.push(node);
    }
  }
  return result as T[];
}

const normalizeForComparison = (text: string) =>
  text.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();

// Alternativas que dependem da posição ou da letra deixam de fazer sentido com o embaralhamento.
// As letras só contam em maiúscula, para "uma alternativa a esse método" não virar erro.
const ORDER_DEPENDENT_PATTERNS = [
  /\b(?:todas|todos|nenhuma|nenhum)\s+(?:(?:as|os|das|dos)\s+)?(?:(?:alternativas|opcoes|respostas)\s+)?(?:anteriores|acima)\b/i,
  /\b(?:ambas|as duas|os dois)\s+(?:(?:as|os)\s+)?(?:(?:alternativas|opcoes)\s+)?(?:anteriores|acima)\b/i,
  /\b(?:alternativa|opcao|resposta)\s+(?:anterior|seguinte|acima|abaixo)\b/i,
  /\b(?:[Aa]lternativas?|[Oo]pc(?:ao|oes)|[Ll]etras?)\s+[A-E]\b/,
];

export function dependsOnOrder(text: string): boolean {
  const normalized = normalizeForComparison(text);
  return ORDER_DEPENDENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

// "Questão 3", "Questão nº 3 -", "Pergunta 3:" não são enunciado: só o que vem depois.
const QUESTION_LABEL = /^\s*(?:quest[aã]o|pergunta)\s*(?:n[º°o.]?\s*)?\d*\s*[.:)\-–—]*\s*/i;

function headingStatement(heading: Heading): PhrasingContent[] {
  const [first, ...rest] = heading.children;
  if (first?.type !== 'text') return heading.children;
  const remainder = first.value.replace(QUESTION_LABEL, '');
  return remainder ? [{ ...first, value: remainder }, ...rest] : rest;
}

const quoted = (text: string) => `"${truncate(text, 60)}"`;

function renderOption(item: ListItem): string {
  const [only] = item.children;
  // Item de uma linha só: sem o <p> em volta, para a alternativa ficar na mesma linha da letra.
  if (item.children.length === 1 && only?.type === 'paragraph') return renderInline(only.children);
  return renderNodes(item.children);
}

interface QuestionInput {
  position: number;
  heading: Heading;
  body: RootContent[];
}

function parseQuestion(
  { position, heading, body }: QuestionInput,
  errors: ImportIssue[],
  warnings: string[],
): ParsedQuestion | null {
  const headingLine = lineOf(heading);
  const flags: CleanupFlags = { html: false, image: false };

  // As alternativas são a última lista de tarefas da questão. Itens comuns no começo da mesma
  // lista são de uma lista do enunciado que se juntou às alternativas por falta de uma frase entre
  // as duas: voltam para o enunciado.
  let listIndex = -1;
  for (let i = body.length - 1; i >= 0; i--) {
    const node = body[i]!;
    if (node.type === 'list' && node.children.some(isTask)) {
      listIndex = i;
      break;
    }
  }

  let statementNodes: RootContent[] = body;
  let items: ListItem[] = [];
  let list: List | null = null;
  if (listIndex !== -1) {
    list = body[listIndex] as List;
    const firstTask = list.children.findIndex(isTask);
    items = list.children.slice(firstTask);
    statementNodes = body.slice(0, listIndex);
    if (firstTask > 0)
      statementNodes.push({ ...list, children: list.children.slice(0, firstTask) });
    if (body.slice(listIndex + 1).some((node) => !isSilent(node))) {
      warnings.push(`Questão ${position}: o texto depois das alternativas foi ignorado.`);
    }
  }

  let statement = cleanNodes(statementNodes, flags);
  if (!plainText(statement)) {
    const fromHeading = cleanNodes(headingStatement(heading), flags);
    statement = plainText(fromHeading) ? [{ type: 'paragraph', children: fromHeading }] : [];
  }
  const statementText = plainText(statement);
  const excerpt = excerptOf(statementText);

  const issue = (line: number | null, detail: string, gptDetail: string) => {
    errors.push({ question: position, line, excerpt, detail, gptDetail });
  };
  const errorsBefore = errors.length;

  if (!statementText) {
    issue(
      headingLine,
      'enunciado vazio.',
      'está sem enunciado; escreva o enunciado entre a linha ## e as alternativas.',
    );
  }

  const listLine = list ? lineOf(list) : headingLine;
  if (items.length === 0) {
    issue(
      headingLine,
      'nenhuma alternativa encontrada (as alternativas são uma lista no formato - [ ] texto).',
      `não tem alternativas no formato - [ ] texto; escreva ${OPTIONS_LABEL}, com a correta marcada como - [x].`,
    );
  } else if (items.length < MIN_OPTIONS || items.length > MAX_OPTIONS) {
    issue(
      listLine,
      `encontrei ${items.length} alternativas, esperado ${OPTIONS_LABEL}.`,
      `tem ${items.length} alternativas; precisa ter ${OPTIONS_LABEL}.`,
    );
  }

  const correctCount = items.filter((item) => item.checked === true).length;
  if (items.length > 0 && correctCount === 0) {
    issue(
      listLine,
      'nenhuma alternativa marcada como correta.',
      'nenhuma alternativa marcada como correta; marque exatamente uma com - [x].',
    );
  } else if (correctCount > 1) {
    issue(
      listLine,
      `${correctCount} alternativas marcadas como corretas.`,
      `tem ${correctCount} alternativas marcadas como corretas; deixe exatamente uma com - [x].`,
    );
  }

  const options = items.map((item) => cleanNodes([item], flags)[0]!);
  const seen = new Set<string>();
  options.forEach((option, index) => {
    const text = plainText([option]);
    const line = lineOf(items[index]!);
    if (!isTask(option)) {
      issue(
        line,
        `a alternativa ${quoted(text)} não começa com [ ] ou [x].`,
        `a alternativa ${quoted(text)} está sem a marcação; use - [ ] texto, ou - [x] texto na correta.`,
      );
    }
    if (!text) {
      issue(
        line,
        `a alternativa ${index + 1} está vazia.`,
        'tem uma alternativa vazia; escreva o texto dela.',
      );
      return;
    }
    if (dependsOnOrder(text)) {
      issue(
        line,
        `a alternativa ${quoted(text)} depende da ordem.`,
        `a alternativa ${quoted(text)} depende da ordem, mas o sistema embaralha as alternativas; troque por outra.`,
      );
    }
    const key = normalizeForComparison(text).toLowerCase();
    if (seen.has(key)) {
      issue(
        line,
        `a alternativa ${quoted(text)} aparece repetida.`,
        `tem duas alternativas iguais (${quoted(text)}); troque uma delas.`,
      );
    }
    seen.add(key);
  });

  if (flags.image) {
    issue(
      headingLine,
      'tem imagem, e imagens não são suportadas.',
      'usa uma imagem, e o sistema não aceita imagens; reescreva a questão sem depender dela.',
    );
  }
  if (flags.html) warnings.push(`Questão ${position}: o HTML foi removido.`);

  if (errors.length > errorsBefore) return null;
  return {
    position,
    sourceLine: headingLine,
    statementHtml: renderNodes(statement),
    optionsHtml: options.map(renderOption),
    correct: items.findIndex((item) => item.checked === true),
  };
}

/**
 * Lê o arquivo de questões (seção 4.2 do plano). A importação é tudo ou nada: se `errors` não
 * estiver vazio, nada deve ser gravado. Os avisos não impedem a importação.
 */
export function parseQuestions(markdown: string): ParseResult {
  const nodes = parseMarkdown(markdown).children;
  const errors: ImportIssue[] = [];
  const warnings: string[] = [];
  const questions: ParsedQuestion[] = [];

  const firstQuestion = nodes.findIndex(isQuestionHeading);
  const preamble = firstQuestion === -1 ? nodes : nodes.slice(0, firstQuestion);

  let title: string | null = null;
  let ignoredIntro = false;
  for (const node of preamble) {
    if (title === null && node.type === 'heading' && node.depth === 1) {
      title = plainText([node]).slice(0, TITLE_MAX_LENGTH) || null;
    } else if (!isSilent(node)) {
      ignoredIntro = true;
    }
  }

  if (firstQuestion === -1) {
    errors.push({
      question: null,
      line: null,
      excerpt: null,
      detail: 'Nenhuma questão encontrada (cada questão começa com ##).',
      gptDetail:
        'Nenhuma questão foi encontrada: cada questão precisa começar com uma linha ## Questão N.',
    });
    return { title, questions, errors, warnings };
  }

  if (ignoredIntro) warnings.push('O texto antes da 1ª questão foi ignorado.');

  let position = 0;
  for (let i = firstQuestion; i < nodes.length;) {
    const heading = nodes[i] as Heading;
    let end = i + 1;
    while (end < nodes.length && !isQuestionHeading(nodes[end]!)) end++;
    position++;
    const question = parseQuestion(
      { position, heading, body: nodes.slice(i + 1, end) },
      errors,
      warnings,
    );
    if (question) questions.push(question);
    i = end;
  }

  return { title, questions, errors, warnings };
}
