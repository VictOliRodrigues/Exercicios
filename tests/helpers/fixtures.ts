import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { attemptBanks, attempts } from '../../src/db/schema.js';
import { addMembers, createGroup } from '../../src/modules/groups/groups.service.js';
import { createUser, type NewUser } from '../../src/modules/users/users.service.js';
import { csrfFrom, login, type buildTestApp } from './test-app.js';

export const PASSWORD = 'senha-correta-123';

type TestContext = Awaited<ReturnType<typeof buildTestApp>>;

export function fixtures(ctx: () => TestContext) {
  const agent = () => request.agent(ctx().app);

  function addUser(overrides: Partial<NewUser> = {}) {
    return createUser(ctx().db, ctx().crypto, {
      name: 'Maria da Silva',
      email: 'maria@exemplo.com',
      phone: '48999990000',
      password: PASSWORD,
      role: 'user',
      mustChangePassword: false,
      ...overrides,
    });
  }

  /** Cria o usuário e devolve um agente já logado. */
  async function loggedUser(name: string, email: string) {
    const id = await addUser({ name, email });
    const user = agent();
    const res = await login(user, email, PASSWORD);
    if (res.status !== 302) throw new Error(`Login de ${email} falhou (${res.status})`);
    return { id, agent: user };
  }

  async function loggedAdmin() {
    const id = await addUser({ name: 'Administrador', email: 'admin@exemplo.com', role: 'admin' });
    const admin = agent();
    await login(admin, 'admin@exemplo.com', PASSWORD);
    return { id, agent: admin };
  }

  async function addGroup(name: string, memberIds: string[] = []) {
    const id = await createGroup(ctx().db, ctx().crypto, name);
    await addMembers(ctx().db, id, memberIds);
    return id;
  }

  /** Envia um .md pela tela de importação. */
  async function upload(
    user: ReturnType<typeof agent>,
    content: string | Buffer,
    options: { fileName?: string; groups?: string[] } = {},
  ) {
    const _csrf = await csrfFrom(user, '/bancos/importar');
    let req = user.post('/bancos').field('_csrf', _csrf);
    for (const group of options.groups ?? []) req = req.field('grupos', group);
    return req.attach('arquivo', Buffer.from(content), options.fileName ?? 'questoes.md');
  }

  /** Importa e devolve o id do simulado (a partir do redirecionamento). */
  async function importBank(
    user: ReturnType<typeof agent>,
    content: string,
    options: { fileName?: string; groups?: string[] } = {},
  ) {
    const res = await upload(user, content, options);
    const match = /^\/bancos\/([0-9a-f-]{36})$/.exec(res.headers.location ?? '');
    if (!match) throw new Error(`Importação falhou (${res.status}): ${res.text.slice(0, 500)}`);
    return match[1]!;
  }

  /** Simula "já fez" direto no banco, sem passar pela tela de iniciar. */
  async function addAttempt(userId: string, bankId: string) {
    const id = uuidv7();
    await ctx().db.insert(attempts).values({
      id,
      userId,
      bankId,
      status: 'in_progress',
      totalQuestions: 1,
      startedAt: new Date(),
    });
    await ctx().db.insert(attemptBanks).values({ attemptId: id, bankId, position: 1 });
  }

  /**
   * "Iniciar novo simulado" pela página do simulado; devolve o id da tentativa. Como na tela, a
   * caixa "Embaralhar" vem marcada (embaralhar: false a desmarca).
   */
  async function startAttempt(
    user: ReturnType<typeof agent>,
    bankId: string,
    {
      embaralhar = true,
      ...options
    }: {
      quantidade?: string;
      minutos?: string;
      modoQuantidade?: string;
      modoTempo?: string;
      embaralhar?: boolean;
    } = {},
  ) {
    const body = embaralhar ? { ...options, embaralhar: '1' } : options;
    const res = await postForm(user, `/bancos/${bankId}`, `/bancos/${bankId}/simulados`, body);
    const match = /^\/simulados\/([0-9a-f-]{36})$/.exec(res.headers.location ?? '');
    if (!match) throw new Error(`Início falhou (${res.status}): ${res.headers.location}`);
    return match[1]!;
  }

  /** Envia um formulário simples, com o token CSRF tirado da página indicada. */
  async function postForm(
    user: ReturnType<typeof agent>,
    pagePath: string,
    action: string,
    body: Record<string, string | string[]> = {},
  ) {
    // Campos repetidos (caixas de seleção) como o navegador manda: grupos=a&grupos=b.
    const params = new URLSearchParams({ _csrf: await csrfFrom(user, pagePath) });
    for (const [key, value] of Object.entries(body)) {
      for (const item of [value].flat()) params.append(key, item);
    }
    return user.post(action).type('form').send(params.toString());
  }

  return {
    agent,
    addUser,
    loggedUser,
    loggedAdmin,
    addGroup,
    upload,
    importBank,
    addAttempt,
    startAttempt,
    postForm,
  };
}

export const simpleBank = (title: string, count = 2) =>
  `# ${title}\n\n` +
  Array.from(
    { length: count },
    (_, i) => `## Questão ${i + 1}\nPergunta ${i + 1}?\n\n- [ ] a\n- [x] b\n- [ ] c\n- [ ] d\n`,
  ).join('\n');
