import type { PhrasingContent, Root, RootContent } from 'mdast';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

const parser = unified().use(remarkParse).use(remarkGfm);

/** Lê o Markdown (com GFM: tabelas e listas de tarefas) e devolve a árvore com as posições. */
export function parseMarkdown(markdown: string): Root {
  return parser.parse(markdown);
}

// Esquema do GitHub, sem caixas de seleção: o gabarito nunca vira um <input> marcado.
const schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== 'input'),
};

// O remark-rehype já descarta o HTML cru; o rehype-sanitize é a segunda barreira.
const renderer = unified().use(remarkRehype).use(rehypeSanitize, schema).use(rehypeStringify);

/** Converte trechos da árvore do Markdown em HTML sanitizado. */
export function renderNodes(nodes: RootContent[]): string {
  const tree = renderer.runSync({ type: 'root', children: nodes });
  return renderer.stringify(tree).trim();
}

/**
 * Converte um trecho de uma linha só (sem o <p> em volta). Passar pelo parágrafo evita as quebras
 * de linha que o conversor põe entre nós soltos na raiz.
 */
export function renderInline(nodes: PhrasingContent[]): string {
  const tree = renderer.runSync({
    type: 'root',
    children: [{ type: 'paragraph', children: nodes }],
  });
  const [paragraph] = tree.children;
  if (tree.children.length === 1 && paragraph?.type === 'element' && paragraph.tagName === 'p') {
    tree.children = paragraph.children;
  }
  return renderer.stringify(tree).trim();
}
