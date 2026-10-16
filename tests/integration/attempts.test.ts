import { and, asc, eq } from 'drizzle-orm';
import type { Agent } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { attemptQuestions, attempts, questions } from '../../src/db/schema.js';
import { letterLabel } from '../../src/modules/attempts/attempt-logic.js';
import { fixtures, simpleBank } from '../helpers/fixtures.js';
import { buildTestApp, csrfFrom, resetTables } from '../helpers/test-app.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const { loggedUser, loggedAdmin, addGroup, importBank, startAttempt, postForm } = fixtures(
  () => ctx,
);

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetTables(ctx.pool);
});

// No simpleBank, as alternativas são a, b, c, d e a correta é sempre a "b" (índice original 1).
const OPTION_TEXTS = ['a', 'b', 'c', 'd'];
const CORRECT = 1;

async function attemptRow(id: string) {
  const [row] = await ctx.db.select().from(attempts).where(eq(attempts.id, id));
  return row!;
}

/** Questões da tentativa na ordem dos números. */
async function placement(attemptId: string) {
  return ctx.db
    .select()
    .from(attemptQuestions)
    .where(eq(attemptQuestions.attemptId, attemptId))
    .orderBy(asc(attemptQuestions.number));
}

type Placed = Awaited<ReturnType<typeof placement>>[number];

/** Letra (0 = A) em que a alternativa correta apareceu nesta tentativa. */
const rightLetter = (row: Placed) => row.optionOrder.indexOf(CORRECT);
/** Uma letra errada qualquer. */
const wrongLetter = (row: Placed) => (rightLetter(row) + 1) % 4;

function pageSizes(rows: Placed[]) {
  const sizes = new Map<number, number>();
  for (const row of rows) sizes.set(row.page, (sizes.get(row.page) ?? 0) + 1);
  return [...sizes.entries()].sort((a, b) => a[0] - b[0]).map(([, size]) => size);
}

/** Campos da prova: q<número>=<letra>. */
const answerFields = (entries: [number, number][]) =>
  Object.fromEntries(entries.map(([number, letter]) => [`q${number}`, String(letter)]));

// O token CSRF é da sessão: vem do painel, porque a prova redireciona depois de finalizada.
const examPost = (user: Agent, attemptId: string, action: string, body = {}) =>
  postForm(user, '/', `/simulados/${attemptId}/${action}`, body);

async function putAnswer(
  user: Agent,
  attemptId: string,
  number: number,
  letter: unknown,
  token?: string,
) {
  token ??= await csrfFrom(user, '/');
  return user
    .put(`/api/simulados/${attemptId}/respostas/${number}`)
    .set('X-CSRF-Token', token)
    .send({ alternativa: letter });
}

const questionCount = (html: string) =>
  (html.match(/<article class="card question"/g) ?? []).length;

/** Muda o relógio da tentativa: o prazo passa a ser `deadlineFromNowMs` a partir de agora. */
async function moveDeadline(attemptId: string, deadlineFromNowMs: number) {
  const row = await attemptRow(attemptId);
  const deadlineAt = new Date(Date.now() + deadlineFromNowMs);
  const startedAt = new Date(deadlineAt.getTime() - row.timeLimitSeconds! * 1000);
  await ctx.db.update(attempts).set({ startedAt, deadlineAt }).where(eq(attempts.id, attemptId));
  return { startedAt, deadlineAt };
}

describe('iniciar simulado', () => {
  it('25 questões, todas por padrão, embaralhadas em 3 páginas de até 10', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Grande', 25));
    const before = Date.now();
    const attemptId = await startAttempt(ana, bankId);

    const row = await attemptRow(attemptId);
    expect(row.status).toBe('in_progress');
    expect(row.totalQuestions).toBe(25);
    expect(row.deadlineAt).toBeNull();
    expect(row.startedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const rows = await placement(attemptId);
    expect(pageSizes(rows)).toEqual([10, 10, 5]);
    for (const q of rows) expect([...q.optionOrder].sort()).toEqual([0, 1, 2, 3]);

    const first = await ana.get(`/simulados/${attemptId}`);
    expect(first.status).toBe(200);
    expect(first.text).toContain('<dd class="exam-stat-value">1 de 3</dd>');
    expect(first.text).toContain('data-answered-count>0</span>/25');
    expect(questionCount(first.text)).toBe(10);
    expect(first.text).toContain('Próxima →');
    expect(first.text).not.toContain(`formaction="/simulados/${attemptId}/finalizar"`);

    const last = await ana.get(`/simulados/${attemptId}?pagina=3`);
    expect(last.text).toContain('<dd class="exam-stat-value">3 de 3</dd>');
    expect(questionCount(last.text)).toBe(5);
    expect(last.text).toContain(`formaction="/simulados/${attemptId}/finalizar"`);
    // Página fora do intervalo cai na mais próxima.
    expect((await ana.get(`/simulados/${attemptId}?pagina=99`)).text).toContain(
      '<dd class="exam-stat-value">3 de 3</dd>',
    );
  });

  it('o HTML da prova não contém o gabarito: só as letras na ordem embaralhada', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Sem resposta', 10));
    const attemptId = await startAttempt(ana, bankId);
    const html = (await ana.get(`/simulados/${attemptId}`)).text;

    expect(html).not.toMatch(/correct|correta|gabarito|\[x\]|checked/i);
    for (const row of await placement(attemptId)) {
      const article = new RegExp(`id="questao-${row.number}"[\\s\\S]*?</article>`).exec(html)![0];
      const values = [...article.matchAll(/name="q\d+" value="(\d)"/g)].map((m) => m[1]);
      expect(values).toEqual(['0', '1', '2', '3']);
      const texts = [
        ...article.matchAll(/<span class="option-text rich-text">([^<]*)<\/span>/g),
      ].map((m) => m[1]);
      expect(texts).toEqual(row.optionOrder.map((option) => OPTION_TEXTS[option]));
    }
  });

  it('sorteia um número menor de questões e grava o tempo limite', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Sorteio', 25));
    const attemptId = await startAttempt(ana, bankId, { quantidade: '5', minutos: '30' });

    const row = await attemptRow(attemptId);
    expect(row.totalQuestions).toBe(5);
    expect(row.timeLimitSeconds).toBe(1800);
    expect(row.deadlineAt!.getTime() - row.startedAt.getTime()).toBe(1_800_000);
    expect(await placement(attemptId)).toHaveLength(5);

    const page = (await ana.get(`/simulados/${attemptId}`)).text;
    expect(page).toContain('<dd class="exam-stat-value">1 de 1</dd>');
    expect(page).toContain('Tempo restante');
    expect(page).toMatch(/data-remaining="(1800|1799)"/);
  });

  it('"Todas" e "Sem limite" marcados ignoram os números preenchidos ao lado', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Modos', 25));

    const all = await startAttempt(ana, bankId, {
      modoQuantidade: 'todas',
      quantidade: '5',
      modoTempo: 'sem-limite',
      minutos: '30',
    });
    expect(await attemptRow(all)).toMatchObject({ totalQuestions: 25, timeLimitSeconds: null });

    const sampled = await startAttempt(ana, bankId, {
      modoQuantidade: 'sortear',
      quantidade: '5',
      modoTempo: 'limite',
      minutos: '30',
    });
    expect(await attemptRow(sampled)).toMatchObject({ totalQuestions: 5, timeLimitSeconds: 1800 });
  });

  it('opções inválidas não iniciam e explicam o motivo', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Opções', 25));
    const cases = [
      [{ quantidade: '26' }, 'Informe uma quantidade de questões entre 1 e 25.'],
      [{ quantidade: '0' }, 'Informe uma quantidade de questões entre 1 e 25.'],
      [{ quantidade: '2.5' }, 'Informe uma quantidade de questões entre 1 e 25.'],
      [{ minutos: '0' }, 'Informe o tempo limite em minutos, entre 1 e 600'],
      [{ minutos: 'abc' }, 'Informe o tempo limite em minutos, entre 1 e 600'],
    ] as const;
    for (const [body, message] of cases) {
      const res = await postForm(ana, `/bancos/${bankId}`, `/bancos/${bankId}/simulados`, body);
      expect(res.headers.location).toBe(`/bancos/${bankId}`);
      expect((await ana.get(`/bancos/${bankId}`)).text).toContain(message);
    }
    const [rows] = await ctx.pool.query('SELECT COUNT(*) AS total FROM attempts');
    expect((rows as { total: number }[])[0]!.total).toBe(0);
  });

  it('sem "Embaralhar", as questões e as alternativas ficam na ordem do arquivo', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Em ordem', 12));
    expect((await ana.get(`/bancos/${bankId}`)).text).toMatch(
      /name="embaralhar" value="1"[^>]*checked/,
    );
    const attemptId = await startAttempt(ana, bankId, { embaralhar: false });

    expect((await placement(attemptId)).every((row) => row.optionOrder.join() === '0,1,2,3')).toBe(
      true,
    );
    const page = (await ana.get(`/simulados/${attemptId}`)).text;
    const statements = [...page.matchAll(/Pergunta (\d+)\?/g)].map((match) => Number(match[1]));
    expect(statements).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('quem não tem acesso ao simulado recebe 404 ao iniciar', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const { agent: bia } = await loggedUser('Bia Lima', 'bia@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Privado'));
    const res = await postForm(bia, '/', `/bancos/${bankId}/simulados`);
    expect(res.status).toBe(404);
  });
});

describe('fazer a prova', () => {
  it('salvamento automático: recarregar mantém as respostas e o tempo', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Salvar', 12));
    const attemptId = await startAttempt(ana, bankId);
    const [q1] = await placement(attemptId);

    const saved = await putAnswer(ana, attemptId, 1, 2);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ respondidas: 1 });
    // A resposta é guardada pelo índice original, não pela letra.
    expect((await placement(attemptId))[0]!.selectedOption).toBe(q1!.optionOrder[2]);
    // Trocar a resposta não conta duas vezes.
    expect((await putAnswer(ana, attemptId, 1, 3)).body).toEqual({ respondidas: 1 });
    expect((await putAnswer(ana, attemptId, 1, 2)).body).toEqual({ respondidas: 1 });

    // Simula 90 s de prova: ao recarregar, o cronômetro parte do tempo do servidor.
    await ctx.db
      .update(attempts)
      .set({ startedAt: new Date(Date.now() - 90_000) })
      .where(eq(attempts.id, attemptId));
    const page = (await ana.get(`/simulados/${attemptId}`)).text;
    expect(page).toMatch(/name="q1" value="2" checked/);
    expect(page.match(/ checked/g)).toHaveLength(1);
    expect(page).toContain('data-answered-count>1</span>/12');
    expect(Number(/data-elapsed="(\d+)"/.exec(page)![1])).toBeGreaterThanOrEqual(90);
    expect(page).toContain('00:01:3');

    expect((await putAnswer(ana, attemptId, 1, 4)).status).toBe(400);
    expect((await putAnswer(ana, attemptId, 1, '1')).status).toBe(400);
    expect((await putAnswer(ana, attemptId, 13, 1)).status).toBe(400);
    const noToken = await ana
      .put(`/api/simulados/${attemptId}/respostas/2`)
      .send({ alternativa: 1 });
    expect(noToken.status).toBe(403);
    expect((await placement(attemptId))[1]!.selectedOption).toBeNull();
  });

  it('Anterior e Próxima salvam a página; o mapa leva à página da questão', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Navegar', 25));
    const attemptId = await startAttempt(ana, bankId);

    const next = await examPost(ana, attemptId, 'pagina', {
      ...answerFields([
        [1, 0],
        [2, 1],
        [3, 2],
      ]),
      destino: '2',
    });
    expect(next.headers.location).toBe(`/simulados/${attemptId}?pagina=2`);
    const rows = await placement(attemptId);
    expect(rows.slice(0, 3).map((row) => row.selectedOption)).toEqual(
      rows.slice(0, 3).map((row, letter) => row.optionOrder[letter]),
    );

    const page2 = (await ana.get(`/simulados/${attemptId}?pagina=2`)).text;
    expect(page2).toContain('data-answered-count>3</span>/25');
    expect(page2).toMatch(/class="map-item is-answered"[^>]*data-map-number="1"/);
    expect(page2).toMatch(/class="map-item is-current-page"[^>]*data-map-number="11"/);
    expect(page2).toContain('← Anterior');

    const jump = await examPost(ana, attemptId, 'pagina', { ir: '23' });
    expect(jump.headers.location).toBe(`/simulados/${attemptId}?pagina=3#questao-23`);
    // Número que não existe na prova: fica na página pedida.
    const invalid = await examPost(ana, attemptId, 'pagina', { ir: '99', destino: '2' });
    expect(invalid.headers.location).toBe(`/simulados/${attemptId}?pagina=2`);
  });

  it('duas tentativas do mesmo simulado têm ordens e resultados independentes', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Duas vezes', 25));
    const first = await startAttempt(ana, bankId);
    const second = await startAttempt(ana, bankId);
    expect(first).not.toBe(second);

    const firstRows = await placement(first);
    const secondRows = await placement(second);
    const order = (rows: Placed[]) => rows.map((row) => row.questionId).join();
    expect(order(firstRows)).not.toBe(order(secondRows));

    await examPost(ana, first, 'finalizar', {
      ...answerFields(firstRows.map((row) => [row.number, rightLetter(row)])),
    });
    expect((await attemptRow(first)).score).toBe('10.00');
    expect((await attemptRow(second)).status).toBe('in_progress');
    expect((await placement(second)).every((row) => row.selectedOption === null)).toBe(true);

    const bankPage = (await ana.get(`/bancos/${bankId}`)).text;
    expect(bankPage).toContain('Suas tentativas');
    expect(bankPage).toContain('<strong>10,0</strong>');
    expect(bankPage).toContain('Em andamento');
    expect(bankPage).toContain(`href="/simulados/${second}">Continuar`);
    expect(bankPage).toContain(`href="/simulados/${first}/relatorio">Ver relatório`);

    const panel = (await ana.get('/')).text;
    expect(panel).toContain('Em andamento');
    expect(panel).toContain('0 de 25 respondidas');
    expect(panel).toContain('Histórico');
    expect(panel).toContain(`/simulados/${first}/relatorio`);
  });

  it('descartar apaga só a tentativa escolhida; finalizada não é descartada', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Descartar', 3));
    const keep = await startAttempt(ana, bankId);
    const drop = await startAttempt(ana, bankId);
    await putAnswer(ana, drop, 1, 0);

    const res = await examPost(ana, drop, 'descartar');
    expect(res.headers.location).toBe(`/bancos/${bankId}`);
    expect((await ana.get(`/bancos/${bankId}`)).text).toContain('Tentativa descartada.');
    expect(await ctx.db.select().from(attempts).where(eq(attempts.id, drop))).toHaveLength(0);
    expect(await placement(drop)).toHaveLength(0);
    expect((await attemptRow(keep)).status).toBe('in_progress');
    expect((await ana.get(`/simulados/${drop}`)).status).toBe(404);

    await examPost(ana, keep, 'finalizar', { confirmar: '1' });
    await examPost(ana, keep, 'descartar');
    expect((await ana.get(`/bancos/${bankId}`)).text).toContain(
      'Só dá para descartar uma tentativa em andamento.',
    );
    expect((await attemptRow(keep)).status).toBe('finished');
  });

  it('a tentativa de outra pessoa dá 404 em todas as rotas, mesmo com o simulado compartilhado', async () => {
    const ana = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bia = await loggedUser('Bia Lima', 'bia@exemplo.com');
    const group = await addGroup('Grupo', [ana.id, bia.id]);
    const bankId = await importBank(ana.agent, simpleBank('Meu', 3), { groups: [group] });
    const attemptId = await startAttempt(ana.agent, bankId);

    expect((await bia.agent.get(`/simulados/${attemptId}`)).status).toBe(404);
    expect((await bia.agent.get(`/simulados/${attemptId}/relatorio`)).status).toBe(404);
    for (const action of ['pagina', 'finalizar', 'reorganizar', 'descartar']) {
      const res = await postForm(bia.agent, '/', `/simulados/${attemptId}/${action}`, {
        confirmar: '1',
        q1: '0',
      });
      expect(res.status).toBe(404);
    }
    expect((await putAnswer(bia.agent, attemptId, 1, 0)).status).toBe(404);
    const row = await attemptRow(attemptId);
    expect(row.status).toBe('in_progress');
    expect((await placement(attemptId)).every((q) => q.selectedOption === null)).toBe(true);
    expect((await bia.agent.get('/simulados/nao-existe')).status).toBe(404);
  });
});

describe('finalizar e relatório', () => {
  it('sem questões em branco finaliza direto; 7 de 10 dá 7,0 e o relatório mostra as erradas', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Nota', 10));
    const attemptId = await startAttempt(ana, bankId);
    const rows = await placement(attemptId);
    const wrongNumbers = [2, 5, 9];
    const choice = (row: Placed) =>
      wrongNumbers.includes(row.number) ? wrongLetter(row) : rightLetter(row);

    const res = await examPost(
      ana,
      attemptId,
      'finalizar',
      answerFields(rows.map((row) => [row.number, choice(row)])),
    );
    expect(res.headers.location).toBe(`/simulados/${attemptId}/relatorio`);

    const row = await attemptRow(attemptId);
    expect(row).toMatchObject({
      status: 'finished',
      finishReason: 'user',
      correctCount: 7,
      wrongCount: 3,
      blankCount: 0,
      score: '7.00',
    });
    expect(row.durationSeconds).toBeGreaterThanOrEqual(0);
    const graded = await placement(attemptId);
    expect(graded.filter((q) => q.isCorrect === false).map((q) => q.number)).toEqual(wrongNumbers);

    const report = (await ana.get(`/simulados/${attemptId}/relatorio`)).text;
    expect(report).toContain('<span class="stat-value">7,0</span>');
    expect(report).toContain('70% de acerto');
    expect(report).toContain('<span class="stat-value">7</span>');
    expect(report).toContain('<span class="stat-value">3</span>');
    expect(report).toContain('<span class="stat-value">10</span>');
    expect(report).toContain('Finalizado por você');
    expect(report).not.toContain('Encerrado por tempo esgotado');
    expect(report).toContain('3 erradas, na ordem dos números');
    expect(report.match(/class="review-item"/g)).toHaveLength(3);
    for (const number of wrongNumbers) {
      const q = graded[number - 1]!;
      const item = new RegExp(`id="questao-${number}"[\\s\\S]*?</li>`).exec(report)![0];
      const seen = wrongLetter(q);
      expect(item).toContain(
        `Sua resposta:</strong> ${letterLabel(seen)}) ${OPTION_TEXTS[q.optionOrder[seen]!]}`,
      );
      expect(item).toContain(`Correta:</strong> ${letterLabel(rightLetter(q))}) b`);
    }
  });

  it('finalizar é idempotente; depois de finalizado, as respostas não mudam mais', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Fim', 2));
    const attemptId = await startAttempt(ana, bankId);
    const rows = await placement(attemptId);
    await examPost(ana, attemptId, 'finalizar', answerFields([[1, rightLetter(rows[0]!)]]));
    // Uma em branco: pede confirmação; "Sim, finalizar" encerra.
    await examPost(ana, attemptId, 'finalizar', { confirmar: '1' });
    const finished = await attemptRow(attemptId);
    expect(finished).toMatchObject({ status: 'finished', correctCount: 1, blankCount: 1 });

    const again = await examPost(ana, attemptId, 'finalizar', { confirmar: '1', q2: '0' });
    expect(again.headers.location).toBe(`/simulados/${attemptId}/relatorio`);
    expect((await ana.get(`/simulados/${attemptId}`)).headers.location).toBe(
      `/simulados/${attemptId}/relatorio`,
    );
    const page = await examPost(ana, attemptId, 'pagina', { q2: '0', destino: '1' });
    expect(page.headers.location).toBe(`/simulados/${attemptId}/relatorio`);
    const late = await putAnswer(ana, attemptId, 2, 0);
    expect(late.status).toBe(409);
    expect(late.body).toEqual({ finalizado: true, relatorio: `/simulados/${attemptId}/relatorio` });
    expect((await placement(attemptId))[1]!.selectedOption).toBeNull();
    expect(await attemptRow(attemptId)).toEqual(finished);
  });

  it('fluxo completo: em branco → "Não" → responder → finalizar → relatório', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Completo', 25));
    const attemptId = await startAttempt(ana, bankId);
    const rows = await placement(attemptId);
    const blank = [3, 8, 12, 15, 19, 21, 24];

    // Responde todas menos 7 e clica em Finalizar.
    const confirm = await examPost(
      ana,
      attemptId,
      'finalizar',
      answerFields(
        rows.filter((r) => !blank.includes(r.number)).map((r) => [r.number, rightLetter(r)]),
      ),
    );
    expect(confirm.status).toBe(200);
    expect(confirm.text).toContain(
      'Você deixou <strong>7 questões em branco</strong> (3, 8, 12, 15, 19, 21, 24).',
    );
    expect(confirm.text).toContain('Questões em branco contam como erradas.');
    expect(confirm.text).toContain('Sim, finalizar');
    expect(confirm.text).toContain('Não, responder as em branco');
    expect((await attemptRow(attemptId)).status).toBe('in_progress');

    // "Não": as 18 respondidas ficam nas páginas 1 e 2; as 7 em branco, na página 3.
    const reorganized = await examPost(ana, attemptId, 'reorganizar');
    expect(reorganized.headers.location).toBe(`/simulados/${attemptId}?pagina=3`);
    const after = await placement(attemptId);
    expect(pageSizes(after)).toEqual([10, 8, 7]);
    expect(after.map((r) => r.number)).toEqual(rows.map((r) => r.number));
    expect(after.filter((r) => r.page === 3).map((r) => r.number)).toEqual(blank);

    const page3 = (await ana.get(`/simulados/${attemptId}?pagina=3`)).text;
    expect(page3).toContain('<dd class="exam-stat-value">3 de 3</dd>');
    for (const number of blank) expect(page3).toContain(`id="questao-${number}"`);
    expect(page3).toContain(`formaction="/simulados/${attemptId}/finalizar"`);

    // Responde 5 das 7; ficam 19 e 24. O ciclo se repete.
    const stillBlank = [19, 24];
    const second = await examPost(
      ana,
      attemptId,
      'finalizar',
      answerFields(
        after
          .filter((r) => blank.includes(r.number) && !stillBlank.includes(r.number))
          .map((r) => [r.number, rightLetter(r)]),
      ),
    );
    expect(second.text).toContain('Você deixou <strong>2 questões em branco</strong> (19, 24).');
    const again = await examPost(ana, attemptId, 'reorganizar');
    expect(again.headers.location).toBe(`/simulados/${attemptId}?pagina=4`);
    expect(pageSizes(await placement(attemptId))).toEqual([10, 10, 3, 2]);

    // "Sim, finalizar": as em branco contam como erradas.
    const done = await examPost(ana, attemptId, 'finalizar', { confirmar: '1' });
    expect(done.headers.location).toBe(`/simulados/${attemptId}/relatorio`);
    expect(await attemptRow(attemptId)).toMatchObject({
      correctCount: 23,
      wrongCount: 2,
      blankCount: 2,
      score: '9.20',
    });
    const report = (await ana.get(`/simulados/${attemptId}/relatorio`)).text;
    expect(report).toContain('<span class="stat-value">9,2</span>');
    expect(report).toContain('sendo 2 em branco');
    expect(report).toContain('2 em branco, na ordem dos números');
    expect(report.match(/<span class="answer-text">Em branco<\/span>/g)).toHaveLength(2);
    expect(report.indexOf('id="questao-19"')).toBeLessThan(report.indexOf('id="questao-24"'));
  });

  it('o relatório de uma tentativa em andamento volta para a prova', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Andamento'));
    const attemptId = await startAttempt(ana, bankId);
    expect((await ana.get(`/simulados/${attemptId}/relatorio`)).headers.location).toBe(
      `/simulados/${attemptId}`,
    );
  });
});

describe('tempo limite', () => {
  it('mostra o tempo restante, vermelho nos últimos 5 minutos', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Relógio'));
    const attemptId = await startAttempt(ana, bankId, { minutos: '10' });
    expect((await ana.get(`/simulados/${attemptId}`)).text).not.toContain('is-urgent');
    await moveDeadline(attemptId, 4 * 60_000);
    const page = (await ana.get(`/simulados/${attemptId}`)).text;
    expect(page).toContain('exam-remaining is-urgent');
    expect(page).toMatch(/data-remaining="(240|239)"/);
  });

  it('resposta depois do prazo é recusada e a tentativa é finalizada no prazo', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Prazo', 3));
    const attemptId = await startAttempt(ana, bankId, { minutos: '10' });
    // O token vem antes de mudar o prazo: abrir o painel depois já finalizaria a tentativa.
    const token = await csrfFrom(ana, '/');
    const { deadlineAt } = await moveDeadline(attemptId, -6_000);

    const late = await putAnswer(ana, attemptId, 1, 0, token);
    expect(late.status).toBe(409);
    expect(late.body.relatorio).toBe(`/simulados/${attemptId}/relatorio`);
    expect((await placement(attemptId))[0]!.selectedOption).toBeNull();
    expect(await attemptRow(attemptId)).toMatchObject({
      status: 'finished',
      finishReason: 'time',
      finishedAt: deadlineAt,
      durationSeconds: 600,
      blankCount: 3,
      score: '0.00',
    });
  });

  it('dentro da tolerância de 5 s, o envio automático salva a página e finaliza por tempo', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Tolerância', 3));
    const attemptId = await startAttempt(ana, bankId, { minutos: '10' });
    const rows = await placement(attemptId);
    const _csrf = await csrfFrom(ana, '/');
    await moveDeadline(attemptId, -2_000);

    // O prova.js envia o formulário para Finalizar quando o tempo zera, sem confirmação.
    const res = await ana
      .post(`/simulados/${attemptId}/finalizar`)
      .type('form')
      .send({
        _csrf,
        ...answerFields([
          [1, rightLetter(rows[0]!)],
          [2, rightLetter(rows[1]!)],
        ]),
      });
    expect(res.headers.location).toBe(`/simulados/${attemptId}/relatorio`);
    expect(await attemptRow(attemptId)).toMatchObject({
      finishReason: 'time',
      correctCount: 2,
      blankCount: 1,
    });
  });

  it('com o navegador fechado, qualquer acesso depois do prazo finaliza a tentativa', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Fechado', 4));
    const attemptId = await startAttempt(ana, bankId, { minutos: '10' });
    const [q1] = await placement(attemptId);
    await putAnswer(ana, attemptId, 1, rightLetter(q1!));
    const { deadlineAt } = await moveDeadline(attemptId, -60_000);

    // O painel finaliza antes de listar: a tentativa já aparece no histórico.
    const panel = (await ana.get('/')).text;
    expect(panel).not.toContain('Em andamento');
    expect(panel).toContain('Tempo esgotado');
    expect(panel).toContain('<strong>2,5</strong><span class="muted"> · 1 de 4</span>');
    expect(await attemptRow(attemptId)).toMatchObject({
      status: 'finished',
      finishReason: 'time',
      finishedAt: deadlineAt,
    });

    const report = (await ana.get(`/simulados/${attemptId}/relatorio`)).text;
    expect(report).toContain('Encerrado por tempo esgotado');
    expect(report).toContain('<span class="stat-clock">00:10:00</span>');
    expect(report).toContain('Tempo limite: 00:10:00');
    expect(report).toContain('sendo 3 em branco');
  });

  it('abrir a prova vencida também finaliza e leva ao relatório', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Vencida'));
    const attemptId = await startAttempt(ana, bankId, { minutos: '1' });
    await moveDeadline(attemptId, -1);
    const res = await ana.get(`/simulados/${attemptId}`);
    expect(res.headers.location).toBe(`/simulados/${attemptId}/relatorio`);
    expect((await attemptRow(attemptId)).finishReason).toBe('time');
  });
});

describe('quem já fez fica com o simulado', () => {
  it('quando o compartilhamento acaba, quem fez continua com ele como "Recebido de"', async () => {
    const ana = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bia = await loggedUser('Bia Lima', 'bia@exemplo.com');
    const caio = await loggedUser('Caio Dias', 'caio@exemplo.com');
    const group = await addGroup('Grupo Um', [ana.id, bia.id, caio.id]);
    const bankId = await importBank(ana.agent, simpleBank('Direito', 3), { groups: [group] });

    const biaAttempt = await startAttempt(bia.agent, bankId);
    await examPost(bia.agent, biaAttempt, 'finalizar', { confirmar: '1' });

    await postForm(ana.agent, `/bancos/${bankId}`, `/bancos/${bankId}/compartilhamento`);
    expect((await caio.agent.get(`/bancos/${bankId}`)).status).toBe(404);

    const bankPage = (await bia.agent.get(`/bancos/${bankId}`)).text;
    expect(bankPage).toContain('Recebido de Ana Souza');
    expect(bankPage).toContain(`/simulados/${biaAttempt}/relatorio`);
    expect((await bia.agent.get('/')).text).toContain('Recebido de Ana Souza');
    // Pode refazer, e o relatório antigo continua.
    const again = await startAttempt(bia.agent, bankId);
    expect((await bia.agent.get(`/simulados/${again}`)).status).toBe(200);
    expect((await bia.agent.get(`/simulados/${biaAttempt}/relatorio`)).status).toBe(200);
  });

  it('tentativa descartada não conta: sem nenhuma, quem recebeu perde o acesso', async () => {
    const ana = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bia = await loggedUser('Bia Lima', 'bia@exemplo.com');
    const group = await addGroup('Grupo Um', [ana.id, bia.id]);
    const bankId = await importBank(ana.agent, simpleBank('Direito'), { groups: [group] });
    const attemptId = await startAttempt(bia.agent, bankId);

    const { agent: admin } = await loggedAdmin();
    await postForm(
      admin,
      `/admin/grupos/${group}`,
      `/admin/grupos/${group}/membros/${bia.id}/remover`,
    );
    expect((await bia.agent.get(`/bancos/${bankId}`)).status).toBe(200);

    const res = await examPost(bia.agent, attemptId, 'descartar');
    expect(res.headers.location).toBe('/');
    expect((await bia.agent.get('/')).text).toContain('Tentativa descartada.');
    expect((await bia.agent.get(`/bancos/${bankId}`)).status).toBe(404);
  });

  it('o dono que exclui o simulado perde o acesso, mas continua vendo os próprios relatórios', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Excluído'));
    const attemptId = await startAttempt(ana, bankId);
    await examPost(ana, attemptId, 'finalizar', { confirmar: '1' });
    await postForm(ana, `/bancos/${bankId}`, `/bancos/${bankId}/excluir`);

    expect((await ana.get(`/bancos/${bankId}`)).status).toBe(404);
    const report = await ana.get(`/simulados/${attemptId}/relatorio`);
    expect(report.status).toBe(200);
    expect(report.text).toContain('Excluído');
    expect(report.text).not.toContain('Fazer de novo');
    expect((await ana.get('/')).text).toContain(`/simulados/${attemptId}/relatorio`);
    const restart = await postForm(ana, '/', `/bancos/${bankId}/simulados`);
    expect(restart.status).toBe(404);
    expect(
      await ctx.db
        .select()
        .from(attempts)
        .where(and(eq(attempts.bankId, bankId), eq(attempts.status, 'in_progress'))),
    ).toHaveLength(0);
  });
});

describe('múltiplos simulados', () => {
  /** A Ana tem um simulado próprio e recebe um da Bia pelo grupo. */
  async function setup() {
    const ana = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bia = await loggedUser('Bia Lima', 'bia@exemplo.com');
    const groupId = await addGroup('Turma', [ana.id, bia.id]);
    const own = await importBank(ana.agent, simpleBank('Português', 3));
    const shared = await importBank(bia.agent, simpleBank('Matemática', 4), { groups: [groupId] });
    return { ana, bia, own, shared };
  }

  const startMultiple = (user: Agent, body: Record<string, string | string[]>) =>
    postForm(user, '/simulados/multiplos', '/simulados/multiplos', body);

  const attemptIdFrom = (location: string | undefined) => {
    const match = /^\/simulados\/([0-9a-f-]{36})$/.exec(location ?? '');
    if (!match) throw new Error(`Início falhou: ${location}`);
    return match[1]!;
  };

  it('o painel só mostra o botão com pelo menos dois simulados', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    await importBank(ana, simpleBank('Um'));
    expect((await ana.get('/')).text).not.toContain('href="/simulados/multiplos"');
    await importBank(ana, simpleBank('Dois'));
    expect((await ana.get('/')).text).toContain('href="/simulados/multiplos"');
  });

  it('junta os próprios e os dos grupos numa prova só', async () => {
    const { ana, own, shared } = await setup();
    const page = (await ana.agent.get('/simulados/multiplos')).text;
    expect(page).toContain(`value="${own}"`);
    expect(page).toContain(`value="${shared}"`);
    expect(page).toContain('4 questões · Enviado por Bia Lima em Turma');

    const res = await startMultiple(ana.agent, { bancos: [own, shared], embaralhar: '1' });
    const attemptId = attemptIdFrom(res.headers.location);
    expect(await attemptRow(attemptId)).toMatchObject({ bankId: null, totalQuestions: 7 });
    expect((await ana.agent.get(`/simulados/${attemptId}`)).text).toContain('Múltiplos simulados');

    const panel = (await ana.agent.get('/')).text;
    expect(panel).toContain('Múltiplos simulados</a>');
    expect(panel).toContain('Português e Matemática');
    // Fica no painel, mas não em "Suas tentativas" de cada simulado.
    expect((await ana.agent.get(`/bancos/${own}`)).text).not.toContain(attemptId);

    // Marcando um só, é uma tentativa comum daquele simulado.
    const single = attemptIdFrom(
      (await startMultiple(ana.agent, { bancos: own })).headers.location,
    );
    expect(await attemptRow(single)).toMatchObject({ bankId: own, totalQuestions: 3 });
  });

  it('sem embaralhar, segue a ordem dos simulados; o relatório diz de onde veio cada questão', async () => {
    const { ana, own, shared } = await setup();
    // A ordem é a da lista (os próprios primeiro), não a de envio do formulário.
    const res = await startMultiple(ana.agent, { bancos: [shared, own] });
    const attemptId = attemptIdFrom(res.headers.location);

    const order = await ctx.db
      .select({ bankId: questions.bankId, position: questions.position })
      .from(attemptQuestions)
      .innerJoin(questions, eq(questions.id, attemptQuestions.questionId))
      .where(eq(attemptQuestions.attemptId, attemptId))
      .orderBy(asc(attemptQuestions.number));
    expect(order.map((row) => row.bankId)).toEqual([own, own, own, shared, shared, shared, shared]);
    for (const bankId of [own, shared]) {
      const positions = order.filter((row) => row.bankId === bankId).map((row) => row.position);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
    expect((await placement(attemptId)).every((row) => row.optionOrder.join() === '0,1,2,3')).toBe(
      true,
    );

    await examPost(ana.agent, attemptId, 'finalizar', { confirmar: '1' });
    const report = (await ana.agent.get(`/simulados/${attemptId}/relatorio`)).text;
    expect(report).toContain('Com as questões de Português e Matemática.');
    expect(report).toMatch(/id="questao-3"[\s\S]*?· Português<\/span>/);
    expect(report).toMatch(/id="questao-4"[\s\S]*?· Matemática<\/span>/);
  });

  it('quem fez junto continua com o simulado do grupo depois que o compartilhamento acaba', async () => {
    const { ana, bia, own, shared } = await setup();
    await startMultiple(ana.agent, { bancos: [own, shared] });
    await postForm(bia.agent, `/bancos/${shared}`, `/bancos/${shared}/compartilhamento`);
    expect((await ana.agent.get(`/bancos/${shared}`)).status).toBe(200);
  });

  it('não inicia sem nada marcado, com simulado sem acesso ou com quantidade demais', async () => {
    const { ana, own, shared } = await setup();
    const { agent: caio } = await loggedUser('Caio Reis', 'caio@exemplo.com');
    const other = await importBank(caio, simpleBank('Do Caio'));
    const cases: [Record<string, string | string[]>, string][] = [
      [{}, 'Marque pelo menos um simulado.'],
      [{ bancos: [own, other] }, 'Algum simulado marcado não está mais disponível.'],
      [
        { bancos: [own, shared], modoQuantidade: 'sortear', quantidade: '8' },
        'Informe uma quantidade de questões entre 1 e 7.',
      ],
    ];
    for (const [body, message] of cases) {
      const res = await startMultiple(ana.agent, body);
      expect(res.status).toBe(422);
      expect(res.text).toContain(message);
      expect(res.text).not.toContain('Do Caio');
    }
    // O que estava marcado continua marcado.
    const last = await startMultiple(ana.agent, cases[2]![0]);
    expect(last.text).toContain(`value="${own}" checked`);
    expect(last.text).toMatch(/value="sortear" id="modo-sortear" checked/);
    const [rows] = await ctx.pool.query('SELECT COUNT(*) AS total FROM attempts');
    expect((rows as { total: number }[])[0]!.total).toBe(0);
  });
});

describe('excluir relatório', () => {
  it('apaga a tentativa finalizada, com as respostas, e volta para onde estava', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Para excluir', 3));
    const attemptId = await startAttempt(ana, bankId);
    await examPost(ana, attemptId, 'finalizar', { confirmar: '1' });
    expect((await ana.get(`/simulados/${attemptId}/relatorio`)).text).toContain(
      `action="/simulados/${attemptId}/excluir"`,
    );

    const res = await postForm(ana, `/bancos/${bankId}`, `/simulados/${attemptId}/excluir`);
    expect(res.headers.location).toBe(`/bancos/${bankId}`);
    expect((await ana.get(`/bancos/${bankId}`)).text).toContain('Relatório excluído.');
    expect((await ana.get(`/simulados/${attemptId}/relatorio`)).status).toBe(404);
    expect(await placement(attemptId)).toHaveLength(0);
    const [rows] = await ctx.pool.query('SELECT COUNT(*) AS total FROM attempt_banks');
    expect((rows as { total: number }[])[0]!.total).toBe(0);

    // Pelo histórico do painel, volta para o painel.
    const other = await startAttempt(ana, bankId);
    await examPost(ana, other, 'finalizar', { confirmar: '1' });
    const fromPanel = await postForm(ana, '/', `/simulados/${other}/excluir`, { voltar: 'painel' });
    expect(fromPanel.headers.location).toBe('/');
    expect((await ana.get('/')).text).not.toContain(`/simulados/${other}/relatorio`);
  });

  it('não apaga tentativa em andamento nem a de outra pessoa', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const { agent: bia } = await loggedUser('Bia Lima', 'bia@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Em andamento'));
    const attemptId = await startAttempt(ana, bankId);

    const res = await postForm(ana, `/bancos/${bankId}`, `/simulados/${attemptId}/excluir`);
    expect(res.headers.location).toBe(`/bancos/${bankId}`);
    expect((await ana.get(`/bancos/${bankId}`)).text).toContain(
      'Só dá para excluir o relatório de uma tentativa finalizada.',
    );
    expect((await attemptRow(attemptId)).status).toBe('in_progress');

    await examPost(ana, attemptId, 'finalizar', { confirmar: '1' });
    expect((await postForm(bia, '/', `/simulados/${attemptId}/excluir`)).status).toBe(404);
    expect((await attemptRow(attemptId)).status).toBe('finished');
  });
});
