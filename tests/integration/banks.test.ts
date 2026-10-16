import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Agent } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { questionBanks, questions } from '../../src/db/schema.js';
import type { QuestionPayload } from '../../src/modules/banks/banks.service.js';
import { addMembers } from '../../src/modules/groups/groups.service.js';
import { fixtures, simpleBank } from '../helpers/fixtures.js';
import { buildTestApp, csrfFrom, resetTables } from '../helpers/test-app.js';

const MODEL = readFileSync('modelos/modelo-questoes.md', 'utf8');

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const { loggedUser, loggedAdmin, addGroup, upload, importBank, addAttempt, postForm } = fixtures(
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

const storedFiles = () => readdir(path.join(ctx.env.STORAGE_PATH, 'banks'));

async function bankCount() {
  const [rows] = await ctx.pool.query('SELECT COUNT(*) AS total FROM question_banks');
  return (rows as { total: number }[])[0]!.total;
}

describe('importação', () => {
  it('o modelo importa sem erro, privado, e tudo fica criptografado', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const filesBefore = await storedFiles();
    const res = await upload(ana, MODEL, { fileName: 'modelo-questoes.md' });
    expect(res.status).toBe(302);
    const bankPath = res.headers.location ?? '';
    const bankId = bankPath.split('/').pop()!;

    const page = await ana.get(bankPath);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Modelo de simulado');
    expect(page.text).toContain('5 questões importadas');
    expect(page.text).toContain('Privado');
    expect(page.text).not.toContain('o simulado foi importado mesmo assim');
    // O resultado da importação aparece uma vez só.
    expect((await ana.get(bankPath)).text).not.toContain('questões importadas');

    const panel = await ana.get('/');
    expect(panel.text).toContain('Modelo de simulado');
    expect(panel.text).toContain('5 questões');

    const [bankRows] = await ctx.pool.query('SELECT * FROM question_banks');
    expect(JSON.stringify(bankRows)).not.toMatch(/Modelo de simulado|modelo-questoes/);
    const [questionRows] = await ctx.pool.query('SELECT * FROM questions');
    expect(questionRows).toHaveLength(5);
    expect(JSON.stringify(questionRows)).not.toMatch(/alternativas|tabela/);

    const [bank] = await ctx.db.select().from(questionBanks).where(eq(questionBanks.id, bankId));
    const files = await storedFiles();
    expect(files).toHaveLength(filesBefore.length + 1);
    expect(files).toContain(`${bank!.storageKey}.enc`);
    const onDisk = await readFile(
      path.join(ctx.env.STORAGE_PATH, 'banks', `${bank!.storageKey}.enc`),
    );
    expect(onDisk.toString('latin1')).not.toContain('Quest');
  });

  it('as questões são gravadas com o gabarito e o HTML sanitizado; <script> não passa', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const md =
      '# XSS\n\n## Q\n<script>alert(1)</script>\n\nTexto <img src=x onerror=alert(2)> **ok**\n\n- [ ] a\n- [x] <b onclick="x()">b</b>\n- [ ] c\n- [ ] d\n';
    const bankId = await importBank(ana, md);

    const page = await ana.get(`/bancos/${bankId}`);
    expect(page.text).toContain('<strong>Questão 1:</strong> o HTML foi removido.');

    const [row] = await ctx.db.select().from(questions).where(eq(questions.bankId, bankId));
    const payload = JSON.parse(
      ctx.crypto.decryptField(row!.payloadEnc, 'questions', 'payload', row!.id),
    ) as QuestionPayload;
    expect(payload.correct).toBe(1);
    expect(payload.statementHtml).toBe('<p>Texto  <strong>ok</strong></p>');
    expect(JSON.stringify(payload)).not.toMatch(/<script|<img|onerror|onclick|<b /);
  });

  it('arquivo com erros lista tudo, gera a mensagem para o ChatGPT e não grava nada', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const md =
      '# Ruim\n\n## Questão 1\nQual?\n\n- [ ] a\n- [x] b\n- [ ] c\n\n## Questão 2\n\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d\n';
    const filesBefore = await storedFiles();
    const res = await upload(ana, md);

    expect(res.status).toBe(422);
    expect(res.text).toContain('o arquivo tem 3 problemas');
    expect(res.text).toContain(
      '<strong>Questão 1 · linha 6</strong> Encontrei 3 alternativas, esperado 4.',
    );
    expect(res.text).toContain('<strong>Questão 2 · linha 10</strong> Enunciado vazio.');
    expect(res.text).toContain(
      '<strong>Questão 2 · linha 12</strong> Nenhuma alternativa marcada como correta.',
    );
    expect(res.text).toContain('Copiar mensagem');
    expect(res.text).toContain('1. Questão 1 (&#34;Qual?&#34;): tem 3 alternativas');
    expect(res.text).toContain('me envie novamente o arquivo .md COMPLETO');

    expect(await bankCount()).toBe(0);
    expect(await storedFiles()).toEqual(filesBefore);
  });

  it('recusa arquivo grande, sem .md, fora de UTF-8 ou ausente, sem mensagem para o ChatGPT', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');

    const big = await upload(ana, 'x'.repeat(1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(big.text).toContain('O arquivo passa de 1 MB');

    const txt = await upload(ana, simpleBank('T'), { fileName: 'questoes.txt' });
    expect(txt.status).toBe(422);
    expect(txt.text).toContain('O arquivo precisa ter a extensão .md.');

    const latin1 = await upload(ana, Buffer.from('# Questões\n', 'latin1'));
    expect(latin1.status).toBe(422);
    expect(latin1.text).toContain('O arquivo não está em UTF-8.');

    const _csrf = await csrfFrom(ana, '/bancos/importar');
    const missing = await ana.post('/bancos').field('_csrf', _csrf);
    expect(missing.status).toBe(422);
    expect(missing.text).toContain('Escolha um arquivo .md para importar.');

    for (const res of [big, txt, latin1, missing])
      expect(res.text).not.toContain('Copiar mensagem');
    expect(await bankCount()).toBe(0);
  });

  it('upload sem token CSRF é recusado', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const res = await ana.post('/bancos').attach('arquivo', Buffer.from(MODEL), 'modelo.md');
    expect(res.status).toBe(403);
    expect(await bankCount()).toBe(0);
  });

  it('sem "# Título", usa o nome do arquivo (com acentos)', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const md = simpleBank('x').replace('# x\n\n', 'Introdução solta.\n\n');
    const bankId = await importBank(ana, md, { fileName: 'Revisão_de_Português.md' });
    const page = await ana.get(`/bancos/${bankId}`);
    expect(page.text).toContain('<h1 class="title-lg">Revisão de Português</h1>');
    expect(page.text).toContain('O texto antes da 1ª questão foi ignorado.');
  });

  it('importar para um grupo do qual o usuário não participa é recusado', async () => {
    const { id: ana, agent: anaAgent } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const mine = await addGroup('Meu grupo', [ana]);
    const other = await addGroup('Outro grupo');
    const res = await upload(anaAgent, simpleBank('T'), { groups: [mine, other] });
    expect(res.status).toBe(422);
    expect(res.text).toContain('Você só pode compartilhar com os grupos de que participa.');
    expect(await bankCount()).toBe(0);
  });

  it('modelo e prompt são baixados pelo usuário; o admin recebe 404', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const model = await ana.get('/modelos/modelo-questoes.md');
    expect(model.status).toBe(200);
    expect(model.headers['content-disposition']).toContain('attachment');
    expect(model.headers['content-type']).toContain('text/markdown');
    expect(model.text).toBe(MODEL);

    const prompt = await ana.get('/modelos/prompt-chatgpt.txt');
    expect(prompt.headers['content-type']).toContain('text/plain');
    expect(prompt.text).toContain('ESTRUTURA DO ARQUIVO');
    expect((await ana.get('/modelos/outro.txt')).status).toBe(404);

    const page = await ana.get('/bancos/importar');
    expect(page.text).toContain('Copiar prompt');
    expect(page.text).toContain('Baixar modelo (.md)');

    const { agent: admin } = await loggedAdmin();
    expect((await admin.get('/modelos/modelo-questoes.md')).status).toBe(404);
    expect((await admin.get('/bancos/importar')).status).toBe(404);
  });
});

describe('compartilhamento', () => {
  /** Ana (dona) e Bia em G1; Ana e Caio em G2; Davi fora de tudo. */
  async function scenario() {
    const ana = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bia = await loggedUser('Bia Lima', 'bia@exemplo.com');
    const caio = await loggedUser('Caio Dias', 'caio@exemplo.com');
    const davi = await loggedUser('Davi Rocha', 'davi@exemplo.com');
    const g1 = await addGroup('Grupo Um', [ana.id, bia.id]);
    const g2 = await addGroup('Grupo Dois', [ana.id, caio.id]);
    return { ana, bia, caio, davi, g1, g2 };
  }

  const status = async (user: { agent: Agent }, bankId: string) =>
    (await user.agent.get(`/bancos/${bankId}`)).status;

  it('simulado privado não aparece para mais ninguém', async () => {
    const { ana, bia, davi } = await scenario();
    const bankId = await importBank(ana.agent, simpleBank('Segredo'));
    expect(await status(bia, bankId)).toBe(404);
    expect(await status(davi, bankId)).toBe(404);
    expect((await bia.agent.get('/')).text).not.toContain('Segredo');
  });

  it('compartilhado com dois grupos aparece para os membros dos dois, com "Enviado por"', async () => {
    const { ana, bia, caio, davi, g1, g2 } = await scenario();
    const bankId = await importBank(ana.agent, simpleBank('Direito'), { groups: [g1, g2] });

    const owner = await ana.agent.get(`/bancos/${bankId}`);
    expect(owner.text).toContain('Compartilhado com Grupo Dois e Grupo Um');
    const ownerPanel = (await ana.agent.get('/')).text;
    // Os próprios simulados aparecem só em "Meus simulados", não nas seções dos grupos.
    expect(ownerPanel.match(/Direito/g)).toHaveLength(1);

    for (const member of [bia, caio]) {
      expect(await status(member, bankId)).toBe(200);
      const panel = (await member.agent.get('/')).text;
      expect(panel).toContain('Enviado por Ana Souza');
      expect(panel).toContain('Direito');
    }
    expect((await bia.agent.get(`/bancos/${bankId}`)).text).toContain(
      'Enviado por Ana Souza em Grupo Um',
    );
    expect(await status(davi, bankId)).toBe(404);
  });

  it('simulado em dois grupos da pessoa aparece na seção de cada grupo', async () => {
    const { ana, g1, g2 } = await scenario();
    const eva = await loggedUser('Eva Melo', 'eva@exemplo.com');
    await addMembers(ctx.db, g1, [eva.id]);
    await addMembers(ctx.db, g2, [eva.id]);
    await importBank(ana.agent, simpleBank('Duplo'), { groups: [g1, g2] });
    expect((await eva.agent.get('/')).text.match(/Duplo/g)).toHaveLength(2);
  });

  it('só o dono muda o compartilhamento ou exclui', async () => {
    const { ana, bia, g1 } = await scenario();
    const bankId = await importBank(ana.agent, simpleBank('Direito'), { groups: [g1] });

    const share = await postForm(
      bia.agent,
      `/bancos/${bankId}`,
      `/bancos/${bankId}/compartilhamento`,
      {
        grupos: [],
      },
    );
    expect(share.status).toBe(404);
    const remove = await postForm(bia.agent, `/bancos/${bankId}`, `/bancos/${bankId}/excluir`);
    expect(remove.status).toBe(404);
    expect(await status(bia, bankId)).toBe(200);
    expect((await bia.agent.get(`/bancos/${bankId}`)).text).not.toContain('Excluir simulado');
  });

  it('o dono não compartilha com grupo de que não participa', async () => {
    const { ana, g1 } = await scenario();
    const foreign = await addGroup('Alheio');
    const bankId = await importBank(ana.agent, simpleBank('Direito'));
    await postForm(ana.agent, `/bancos/${bankId}`, `/bancos/${bankId}/compartilhamento`, {
      grupos: [g1, foreign],
    });
    expect((await ana.agent.get(`/bancos/${bankId}`)).text).toContain(
      'Você só pode compartilhar com os grupos de que participa.',
    );
    const [rows] = await ctx.pool.query('SELECT * FROM question_bank_groups');
    expect(rows).toHaveLength(0);
  });

  it('o dono desmarca um grupo: quem nunca fez perde; quem já fez fica com "Recebido de"', async () => {
    const { ana, bia, caio, g1, g2 } = await scenario();
    const bankId = await importBank(ana.agent, simpleBank('Direito'), { groups: [g1, g2] });
    await addAttempt(caio.id, bankId);

    await postForm(ana.agent, `/bancos/${bankId}`, `/bancos/${bankId}/compartilhamento`, {
      grupos: [g1],
    });
    expect((await ana.agent.get(`/bancos/${bankId}`)).text).toContain('Compartilhado com Grupo Um');
    expect(await status(bia, bankId)).toBe(200);

    expect(await status(caio, bankId)).toBe(200);
    const caioPanel = (await caio.agent.get('/')).text;
    expect(caioPanel).toContain('Recebido de Ana Souza');
    expect((await caio.agent.get(`/bancos/${bankId}`)).text).toContain('Recebido de Ana Souza');

    // Sem nenhum grupo marcado, volta a ser privado; a Bia nunca fez e perde o acesso.
    await postForm(ana.agent, `/bancos/${bankId}`, `/bancos/${bankId}/compartilhamento`);
    expect((await ana.agent.get(`/bancos/${bankId}`)).text).toContain('o simulado agora é privado');
    expect(await status(bia, bankId)).toBe(404);
  });

  it('membro removido do grupo perde o acesso, a menos que já tenha feito', async () => {
    const { ana, bia, g1 } = await scenario();
    const dani = await loggedUser('Dani Alves', 'dani@exemplo.com');
    await addMembers(ctx.db, g1, [dani.id]);
    const bankId = await importBank(ana.agent, simpleBank('Direito'), { groups: [g1] });
    await addAttempt(dani.id, bankId);

    const { agent: admin } = await loggedAdmin();
    for (const member of [bia, dani]) {
      await postForm(
        admin,
        `/admin/grupos/${g1}`,
        `/admin/grupos/${g1}/membros/${member.id}/remover`,
      );
    }
    expect(await status(bia, bankId)).toBe(404);
    expect(await status(dani, bankId)).toBe(200);
    expect((await dani.agent.get('/')).text).toContain('Recebido de Ana Souza');
    // Para a dona nada muda: continua compartilhado com o grupo.
    expect((await ana.agent.get(`/bancos/${bankId}`)).text).toContain('Compartilhado com Grupo Um');
  });

  it('dono removido de um grupo: os simulados dele saem só desse grupo', async () => {
    const { ana, bia, caio, g1, g2 } = await scenario();
    const bankId = await importBank(ana.agent, simpleBank('Direito'), { groups: [g1, g2] });

    const { agent: admin } = await loggedAdmin();
    await postForm(admin, `/admin/grupos/${g1}`, `/admin/grupos/${g1}/membros/${ana.id}/remover`);

    expect(await status(bia, bankId)).toBe(404);
    expect(await status(caio, bankId)).toBe(200);
    expect((await ana.agent.get(`/bancos/${bankId}`)).text).toContain(
      'Compartilhado com Grupo Dois',
    );
    expect((await admin.get('/admin/grupos')).text).toMatch(/Grupo Um[\s\S]*?0<\/td>/);
  });

  it('grupo excluído: o simulado sem nenhum grupo volta a ser privado do dono', async () => {
    const { ana, bia, g1 } = await scenario();
    const bankId = await importBank(ana.agent, simpleBank('Direito'), { groups: [g1] });

    const { agent: admin } = await loggedAdmin();
    expect((await admin.get('/admin/grupos')).text).toMatch(/Grupo Um[\s\S]*?1<\/td>/);
    await postForm(admin, `/admin/grupos/${g1}`, `/admin/grupos/${g1}/excluir`);

    expect(await status(bia, bankId)).toBe(404);
    expect((await bia.agent.get('/')).text).not.toContain('Grupo Um');
    const owner = (await ana.agent.get(`/bancos/${bankId}`)).text;
    expect(owner).toContain('Privado');
    expect(owner).not.toContain('Grupo Um');
  });

  it('dono exclui: some para o dono e para quem nunca fez; quem já fez continua', async () => {
    const { ana, bia, caio, g1, g2 } = await scenario();
    const bankId = await importBank(ana.agent, simpleBank('Direito'), { groups: [g1, g2] });
    await addAttempt(caio.id, bankId);

    const res = await postForm(ana.agent, `/bancos/${bankId}`, `/bancos/${bankId}/excluir`);
    expect(res.headers.location).toBe('/');
    expect((await ana.agent.get('/')).text).toContain('Simulado excluído.');
    expect(await status(ana, bankId)).toBe(404);
    expect((await ana.agent.get('/')).text).not.toContain('Direito');
    expect(await status(bia, bankId)).toBe(404);
    expect(await status(caio, bankId)).toBe(200);
    expect((await caio.agent.get('/')).text).toContain('Recebido de Ana Souza');

    const [bank] = await ctx.db.select().from(questionBanks).where(eq(questionBanks.id, bankId));
    expect(bank!.deletedAt).not.toBeNull();
  });

  it('id inválido ou inexistente dá 404', async () => {
    const { ana } = await scenario();
    expect((await ana.agent.get('/bancos/nao-existe')).status).toBe(404);
    expect((await ana.agent.get('/bancos/0192f0c1-0000-7000-8000-000000000000')).status).toBe(404);
  });
});
