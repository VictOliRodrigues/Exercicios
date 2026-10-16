import type { Agent } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, simpleBank } from '../helpers/fixtures.js';
import { buildTestApp, resetTables } from '../helpers/test-app.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const { loggedUser, addGroup, upload, importBank, addAttempt, postForm } = fixtures(() => ctx);

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetTables(ctx.pool);
});

/** Cria a pasta pela tela de nova pasta e devolve o id (a partir do redirecionamento). */
async function createFolder(user: Agent, nome: string, bancos: string[] = []) {
  const res = await postForm(user, '/pastas/nova', '/pastas', { nome, bancos });
  const match = /^\/pastas\/([0-9a-f-]{36})$/.exec(res.headers.location ?? '');
  if (!match) throw new Error(`Criação da pasta falhou (${res.status}): ${res.text.slice(0, 500)}`);
  return match[1]!;
}

async function placementCount() {
  const [rows] = await ctx.pool.query('SELECT COUNT(*) AS total FROM folder_banks');
  return (rows as { total: number }[])[0]!.total;
}

describe('pastas', () => {
  it('cria a pasta com simulados: no painel eles ficam dentro dela, e o nome é criptografado', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const penal = await importBank(ana, simpleBank('Direito Penal'));
    const civil = await importBank(ana, simpleBank('Direito Civil'));
    const portugues = await importBank(ana, simpleBank('Português'));
    const folderId = await createFolder(ana, 'Direito', [penal, civil]);

    const created = await ana.get(`/pastas/${folderId}`);
    expect(created.status).toBe(200);
    expect(created.text).toContain('Pasta Direito criada.');
    expect(created.text).toContain('<h1 class="title-lg">Direito</h1>');
    expect(created.text).toContain(`/pastas/${folderId}/simulados/${penal}/remover`);
    expect(created.text).toContain(`/pastas/${folderId}/simulados/${civil}/remover`);
    expect(created.text).not.toContain(`/simulados/${portugues}/remover`);

    const panel = (await ana.get('/')).text;
    expect(panel).toContain('3 simulados · 1 pasta');
    expect(panel).toContain(`href="/pastas/${folderId}"`);
    expect(panel).toContain('<span class="folder-name">Direito</span>');
    expect(panel).toContain('2 simulados');
    expect(panel).not.toContain(`href="/bancos/${penal}"`);
    expect(panel).not.toContain(`href="/bancos/${civil}"`);
    expect(panel).toContain(`href="/bancos/${portugues}"`);

    const [rows] = await ctx.pool.query('SELECT * FROM folders');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('Direito');
  });

  it('as pastas são de cada um: outra pessoa recebe 404 e o painel do grupo não muda', async () => {
    const ana = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bruno = await loggedUser('Bruno Lima', 'bruno@exemplo.com');
    const group = await addGroup('Turma', [ana.id, bruno.id]);
    const bankId = await importBank(ana.agent, simpleBank('Direito Penal'), { groups: [group] });
    const folderId = await createFolder(ana.agent, 'Minha pasta', [bankId]);

    expect((await bruno.agent.get(`/pastas/${folderId}`)).status).toBe(404);
    for (const action of [
      `/pastas/${folderId}`,
      `/pastas/${folderId}/simulados`,
      `/pastas/${folderId}/simulados/${bankId}/remover`,
      `/pastas/${folderId}/excluir`,
    ]) {
      const res = await postForm(bruno.agent, '/', action, { nome: 'Outra', bancos: [bankId] });
      expect(res.status, action).toBe(404);
    }
    expect((await ana.agent.get(`/pastas/${folderId}`)).text).toContain(
      `/simulados/${bankId}/remover`,
    );

    // Para o Bruno, o simulado continua na seção do grupo, e não pode ir para uma pasta dele.
    const brunoPanel = (await bruno.agent.get('/')).text;
    expect(brunoPanel).toContain(`href="/bancos/${bankId}"`);
    expect(brunoPanel).not.toContain('Minha pasta');
    const brunoBank = (await bruno.agent.get(`/bancos/${bankId}`)).text;
    expect(brunoBank).not.toContain(`/bancos/${bankId}/pasta`);
    const filed = await postForm(bruno.agent, '/', `/bancos/${bankId}/pasta`, { pasta: '' });
    expect(filed.status).toBe(404);
    const brunoFolder = await createFolder(bruno.agent, 'Do Bruno', [bankId]);
    expect((await bruno.agent.get(`/pastas/${brunoFolder}`)).text).toContain('A pasta está vazia');
  });

  it('recusa nome vazio e nome repetido (sem diferenciar maiúsculas e acentos)', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    await createFolder(ana, 'Português');

    const repeated = await postForm(ana, '/pastas/nova', '/pastas', { nome: '  portugues ' });
    expect(repeated.status).toBe(422);
    expect(repeated.text).toContain('Você já tem uma pasta com esse nome.');
    const empty = await postForm(ana, '/pastas/nova', '/pastas', { nome: '   ' });
    expect(empty.status).toBe(422);
    expect(empty.text).toContain('Informe o nome da pasta.');

    // Outra pessoa pode ter uma pasta com o mesmo nome.
    const { agent: bruno } = await loggedUser('Bruno Lima', 'bruno@exemplo.com');
    await createFolder(bruno, 'Português');
  });

  it('na página do simulado, guarda numa pasta, muda de pasta e tira da pasta', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Direito Penal'));
    const bankPath = `/bancos/${bankId}`;
    expect((await ana.get(bankPath)).text).toContain('Você ainda não tem pastas.');
    const first = await createFolder(ana, 'Pasta A');
    const second = await createFolder(ana, 'Pasta B');

    const res = await postForm(ana, bankPath, `${bankPath}/pasta`, { pasta: first });
    expect(res.headers.location).toBe(bankPath);
    const inFirst = (await ana.get(bankPath)).text;
    expect(inFirst).toContain('Simulado guardado na pasta Pasta A.');
    expect(inFirst).toContain(`<a href="/pastas/${first}">Pasta A</a>`);
    expect(inFirst).toContain(`<option value="${first}" selected>Pasta A</option>`);

    await postForm(ana, bankPath, `${bankPath}/pasta`, { pasta: second });
    expect((await ana.get(`/pastas/${first}`)).text).toContain('A pasta está vazia');
    expect((await ana.get(`/pastas/${second}`)).text).toContain(`href="${bankPath}"`);

    await postForm(ana, bankPath, `${bankPath}/pasta`, { pasta: '' });
    const out = (await ana.get(bankPath)).text;
    expect(out).toContain('Simulado tirado da pasta.');
    expect(out).not.toContain('selected>');
    expect((await ana.get('/')).text).toContain(`href="${bankPath}"`);

    // Pasta de outra pessoa não serve.
    const { agent: bruno } = await loggedUser('Bruno Lima', 'bruno@exemplo.com');
    const brunoFolder = await createFolder(bruno, 'Do Bruno');
    await postForm(ana, bankPath, `${bankPath}/pasta`, { pasta: brunoFolder });
    expect((await ana.get(bankPath)).text).toContain('Escolha uma das suas pastas.');
    expect(await placementCount()).toBe(0);
  });

  it('na página da pasta, guarda vários de uma vez (os de outra pasta mudam) e tira da pasta', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const penal = await importBank(ana, simpleBank('Direito Penal'));
    const civil = await importBank(ana, simpleBank('Direito Civil'));
    const other = await createFolder(ana, 'Outra', [civil]);
    const folderId = await createFolder(ana, 'Direito');
    const folderPath = `/pastas/${folderId}`;
    expect((await ana.get(folderPath)).text).toContain('Na pasta Outra');

    const res = await postForm(ana, folderPath, `${folderPath}/simulados`, {
      bancos: [penal, civil],
    });
    expect(res.headers.location).toBe(folderPath);
    const filled = (await ana.get(folderPath)).text;
    expect(filled).toContain('2 simulados guardados na pasta.');
    expect(filled).toContain(`${folderPath}/simulados/${penal}/remover`);
    expect(filled).toContain(`${folderPath}/simulados/${civil}/remover`);
    expect((await ana.get(`/pastas/${other}`)).text).toContain('A pasta está vazia');

    await postForm(ana, folderPath, `${folderPath}/simulados`, {});
    expect((await ana.get(folderPath)).text).toContain(
      'Marque pelo menos um simulado para guardar na pasta.',
    );

    await postForm(ana, folderPath, `${folderPath}/simulados/${penal}/remover`);
    const removed = (await ana.get(folderPath)).text;
    expect(removed).toContain('Simulado tirado da pasta. Ele continua em Meus simulados.');
    expect(removed).not.toContain(`/simulados/${penal}/remover`);
    expect((await ana.get('/')).text).toContain(`href="/bancos/${penal}"`);
  });

  it('o simulado recebido também vai para uma pasta; se voltar a um grupo, sai dela', async () => {
    const ana = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bruno = await loggedUser('Bruno Lima', 'bruno@exemplo.com');
    const group = await addGroup('Turma', [ana.id, bruno.id]);
    const bankId = await importBank(ana.agent, simpleBank('Direito Penal'), { groups: [group] });
    const sharing = `/bancos/${bankId}/compartilhamento`;
    await addAttempt(bruno.id, bankId);
    await postForm(ana.agent, `/bancos/${bankId}`, sharing, {});

    const folderId = await createFolder(bruno.agent, 'Recebidos', [bankId]);
    const folderPage = (await bruno.agent.get(`/pastas/${folderId}`)).text;
    expect(folderPage).toContain(`href="/bancos/${bankId}"`);
    expect(folderPage).toContain('Recebido de Ana Souza');
    const bankPage = (await bruno.agent.get(`/bancos/${bankId}`)).text;
    expect(bankPage).toContain(`<option value="${folderId}" selected>Recebidos</option>`);
    expect(bankPage).not.toContain(`/bancos/${bankId}/nome`);

    await postForm(ana.agent, `/bancos/${bankId}`, sharing, { grupos: [group] });
    expect((await bruno.agent.get(`/pastas/${folderId}`)).text).toContain('A pasta está vazia');
    expect((await bruno.agent.get('/')).text).toContain('Pasta vazia');
  });

  it('renomeia a pasta e, ao excluir, os simulados voltam para Meus simulados', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    const bankId = await importBank(ana, simpleBank('Direito Penal'));
    const folderId = await createFolder(ana, 'Direito', [bankId]);
    const folderPath = `/pastas/${folderId}`;

    const renamed = await postForm(ana, folderPath, folderPath, { nome: 'Penal e Civil' });
    expect(renamed.headers.location).toBe(folderPath);
    const page = (await ana.get(folderPath)).text;
    expect(page).toContain('Nome da pasta atualizado.');
    expect(page).toContain('<h1 class="title-lg">Penal e Civil</h1>');
    const empty = await postForm(ana, folderPath, folderPath, { nome: '' });
    expect(empty.status).toBe(422);
    expect(empty.text).toContain('Informe o nome da pasta.');

    const deleted = await postForm(ana, folderPath, `${folderPath}/excluir`);
    expect(deleted.headers.location).toBe('/');
    const panel = (await ana.get('/')).text;
    expect(panel).toContain('Pasta Penal e Civil excluída.');
    expect(panel).toContain(`href="/bancos/${bankId}"`);
    expect((await ana.get(folderPath)).status).toBe(404);
    expect(await placementCount()).toBe(0);
    expect((await ana.get(`/bancos/${bankId}`)).status).toBe(200);
  });

  it('importa direto numa pasta; pasta de outra pessoa é recusada', async () => {
    const { agent: ana } = await loggedUser('Ana Souza', 'ana@exemplo.com');
    expect((await ana.get('/bancos/importar')).text).not.toContain('name="pasta"');
    const folderId = await createFolder(ana, 'Direito');
    expect((await ana.get('/bancos/importar')).text).toContain(
      `<option value="${folderId}">Direito</option>`,
    );

    const bankId = await importBank(ana, simpleBank('Direito Penal'), { folder: folderId });
    expect((await ana.get(`/pastas/${folderId}`)).text).toContain(`href="/bancos/${bankId}"`);

    const { agent: bruno } = await loggedUser('Bruno Lima', 'bruno@exemplo.com');
    const brunoFolder = await createFolder(bruno, 'Do Bruno');
    const refused = await upload(ana, simpleBank('Direito Civil'), { folder: brunoFolder });
    expect(refused.status).toBe(422);
    expect(refused.text).toContain('Escolha uma das suas pastas.');
    const [rows] = await ctx.pool.query('SELECT COUNT(*) AS total FROM question_banks');
    expect((rows as { total: number }[])[0]!.total).toBe(1);
  });
});
