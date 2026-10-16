import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { studyGroupMembers, studyGroups, users } from '../../src/db/schema.js';
import { fixtures, PASSWORD } from '../helpers/fixtures.js';
import { buildTestApp, csrfFrom, login, resetTables } from '../helpers/test-app.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const { agent, addUser, loggedUser, loggedAdmin, addGroup, postForm } = fixtures(() => ctx);

beforeAll(async () => {
  ctx = await buildTestApp({ FORGOT_MAX_PER_HOUR: '100' });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetTables(ctx.pool);
});

async function userRow(id: string) {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
  return row!;
}

const newUserForm = {
  nome: '  Joana   Pereira ',
  email: 'Joana@Exemplo.com',
  telefone: '(48) 99999-1234',
};

describe('admin: criar usuário', () => {
  it('cria com a senha digitada; o usuário entra e é obrigado a trocar a senha', async () => {
    const { agent: admin } = await loggedAdmin();
    const res = await postForm(admin, '/admin/usuarios', '/admin/usuarios', {
      ...newUserForm,
      senha: 'senha-inicial-1',
      acao: 'digitada',
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/usuarios');

    const list = await admin.get('/admin/usuarios');
    expect(list.text).toContain('Cadastro de Joana Pereira criado.');
    expect(list.text).toContain('joana@exemplo.com');
    expect(list.text).toContain('(48) 99999-1234');
    expect(list.text).toContain('Nunca entrou');

    const user = agent();
    expect((await login(user, 'joana@exemplo.com', 'senha-inicial-1')).headers.location).toBe(
      '/alterar-senha',
    );
  });

  it('com "Criar com senha gerada", mostra a senha uma única vez e ela funciona', async () => {
    const { agent: admin } = await loggedAdmin();
    const res = await postForm(admin, '/admin/usuarios', '/admin/usuarios', {
      ...newUserForm,
      senha: '',
      acao: 'gerar',
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Cadastro criado');
    const password = /id="senha-gerada">([^<]+)</.exec(res.text)?.[1];
    expect(password).toMatch(/^[A-Za-z2-9]{12}$/);

    expect((await admin.get('/admin/usuarios')).text).not.toContain(password!);
    expect((await login(agent(), 'joana@exemplo.com', password!)).headers.location).toBe(
      '/alterar-senha',
    );
  });

  it('valida os campos e o e-mail repetido', async () => {
    const { agent: admin } = await loggedAdmin();
    await addUser({ email: 'joana@exemplo.com' });

    const invalid = await postForm(admin, '/admin/usuarios', '/admin/usuarios', {
      nome: 'Jo',
      email: 'isso-nao-e-email',
      telefone: '9999-1234',
      senha: 'curta',
      acao: 'digitada',
    });
    expect(invalid.status).toBe(422);
    for (const message of [
      'Informe o nome completo.',
      'Informe um e-mail válido.',
      'Informe o telefone com DDD (10 ou 11 dígitos).',
      'A senha precisa ter pelo menos 10 caracteres.',
    ]) {
      expect(invalid.text).toContain(message);
    }
    expect(invalid.text).toContain('value="isso-nao-e-email"');

    const duplicate = await postForm(admin, '/admin/usuarios', '/admin/usuarios', {
      ...newUserForm,
      email: ' JOANA@exemplo.com ',
      acao: 'gerar',
    });
    expect(duplicate.status).toBe(422);
    expect(duplicate.text).toContain('Este e-mail já é usado por outro usuário.');
  });

  it('nome, e-mail e telefone ficam criptografados no banco', async () => {
    const { agent: admin } = await loggedAdmin();
    await postForm(admin, '/admin/usuarios', '/admin/usuarios', {
      ...newUserForm,
      senha: 'senha-inicial-1',
      acao: 'digitada',
    });
    const [rows] = await ctx.pool.query("SELECT * FROM users WHERE role = 'user'");
    const raw = JSON.stringify(rows);
    expect(raw).not.toMatch(/joana|pereira|99999/i);
    expect(raw).not.toContain('senha-inicial-1');
  });
});

describe('admin: lista, edição e desativação', () => {
  it('pedidos de redefinição ficam no topo, depois ativos por nome e por fim os desativados', async () => {
    const { agent: admin } = await loggedAdmin();
    await addUser({ name: 'Bruno Lima', email: 'bruno@exemplo.com' });
    await addUser({ name: 'ana Souza', email: 'ana@exemplo.com' });
    const carla = await addUser({ name: 'Carla Dias', email: 'carla@exemplo.com' });
    const davi = await addUser({ name: 'Davi Rocha', email: 'davi@exemplo.com' });
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, carla));

    const visitor = agent();
    const _csrf = await csrfFrom(visitor, '/esqueci-senha');
    await visitor.post('/esqueci-senha').type('form').send({ _csrf, email: 'davi@exemplo.com' });
    expect((await userRow(davi)).passwordResetRequestedAt).not.toBeNull();

    const page = (await admin.get('/admin/usuarios')).text;
    const order = ['Davi Rocha', 'ana Souza', 'Bruno Lima', 'Carla Dias'].map((name) =>
      page.indexOf(name),
    );
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page).toContain('Esqueceu a senha');
    expect(page).toContain('Desativado');
  });

  it('edita nome, e-mail e telefone; o e-mail novo vira o login', async () => {
    const { agent: admin } = await loggedAdmin();
    const id = await addUser();
    await addUser({ name: 'Outra Pessoa', email: 'outra@exemplo.com' });

    const form = await admin.get(`/admin/usuarios/${id}`);
    expect(form.text).toContain('value="maria@exemplo.com"');
    expect(form.text).toContain('value="(48) 99999-0000"');
    expect(form.text).toContain('Trocar o e-mail troca o login');

    const taken = await postForm(admin, `/admin/usuarios/${id}`, `/admin/usuarios/${id}`, {
      nome: 'Maria Souza',
      email: 'outra@exemplo.com',
      telefone: '4833334444',
    });
    expect(taken.status).toBe(422);
    expect(taken.text).toContain('Este e-mail já é usado por outro usuário.');

    const ok = await postForm(admin, `/admin/usuarios/${id}`, `/admin/usuarios/${id}`, {
      nome: 'Maria Souza',
      email: 'maria.souza@exemplo.com',
      telefone: '4833334444',
    });
    expect(ok.headers.location).toBe('/admin/usuarios');
    const list = (await admin.get('/admin/usuarios')).text;
    expect(list).toContain('Maria Souza');
    expect(list).toContain('(48) 3333-4444');

    expect((await login(agent(), 'maria@exemplo.com', PASSWORD)).status).toBe(401);
    expect((await login(agent(), 'maria.souza@exemplo.com', PASSWORD)).status).toBe(302);
  });

  it('desativar derruba a sessão aberta e impede o login; reativar libera', async () => {
    const { agent: admin } = await loggedAdmin();
    const { id, agent: user } = await loggedUser('Maria da Silva', 'maria@exemplo.com');
    expect((await user.get('/')).status).toBe(200);

    await postForm(admin, '/admin/usuarios', `/admin/usuarios/${id}/ativo`, { ativo: 'false' });
    expect((await userRow(id)).active).toBe(false);
    expect((await user.get('/')).headers.location).toBe('/login');
    expect((await login(agent(), 'maria@exemplo.com', PASSWORD)).status).toBe(401);

    await postForm(admin, '/admin/usuarios', `/admin/usuarios/${id}/ativo`, { ativo: 'true' });
    expect((await login(agent(), 'maria@exemplo.com', PASSWORD)).status).toBe(302);
  });

  it('admin não gerencia a si mesmo pelas telas, e id inexistente dá 404', async () => {
    const { id: adminId, agent: admin } = await loggedAdmin();
    expect((await admin.get(`/admin/usuarios/${adminId}`)).status).toBe(404);
    expect((await admin.get('/admin/usuarios/nao-e-um-id')).status).toBe(404);
    const res = await postForm(admin, '/admin/usuarios', `/admin/usuarios/${adminId}/ativo`, {
      ativo: 'false',
    });
    expect(res.status).toBe(404);
    expect((await userRow(adminId)).active).toBe(true);
  });
});

describe('admin: redefinir senha', () => {
  it('pedido de "Esqueci minha senha" → redefinição derruba a sessão e exige troca', async () => {
    const { agent: admin } = await loggedAdmin();
    const { id, agent: user } = await loggedUser('Maria da Silva', 'maria@exemplo.com');
    await ctx.db
      .update(users)
      .set({ passwordResetRequestedAt: new Date(), failedLogins: 3 })
      .where(eq(users.id, id));

    const page = await admin.get(`/admin/usuarios/${id}/redefinir-senha`);
    expect(page.text).toContain('<dt class="caps-label">Pedido em</dt>');

    const res = await postForm(
      admin,
      `/admin/usuarios/${id}/redefinir-senha`,
      `/admin/usuarios/${id}/redefinir-senha`,
      { senha: 'senha-temporaria-9', acao: 'digitada' },
    );
    expect(res.headers.location).toBe('/admin/usuarios');

    const row = await userRow(id);
    expect(row.passwordResetRequestedAt).toBeNull();
    expect(row.mustChangePassword).toBe(true);
    expect(row.failedLogins).toBe(0);
    expect((await user.get('/')).headers.location).toBe('/login');
    expect((await login(agent(), 'maria@exemplo.com', PASSWORD)).status).toBe(401);
    expect((await login(agent(), 'maria@exemplo.com', 'senha-temporaria-9')).headers.location).toBe(
      '/alterar-senha',
    );
    expect((await admin.get('/admin/usuarios')).text).not.toContain('Esqueceu a senha');
  });

  it('"Gerar senha" mostra a senha nova uma vez; senha curta é recusada', async () => {
    const { agent: admin } = await loggedAdmin();
    const id = await addUser();
    const path = `/admin/usuarios/${id}/redefinir-senha`;

    const short = await postForm(admin, path, path, { senha: 'curta', acao: 'digitada' });
    expect(short.status).toBe(422);
    expect(short.text).toContain('pelo menos 10 caracteres');

    const generated = await postForm(admin, path, path, { senha: '', acao: 'gerar' });
    expect(generated.text).toContain('Senha redefinida');
    const password = /id="senha-gerada">([^<]+)</.exec(generated.text)?.[1];
    expect(password).toMatch(/^[A-Za-z2-9]{12}$/);
    expect((await login(agent(), 'maria@exemplo.com', password!)).headers.location).toBe(
      '/alterar-senha',
    );
  });
});

describe('admin: grupos', () => {
  async function groupRow(id: string) {
    const [row] = await ctx.db.select().from(studyGroups).where(eq(studyGroups.id, id));
    return row!;
  }

  it('cria, renomeia e recusa nome repetido (sem diferenciar maiúsculas e acentos)', async () => {
    const { agent: admin } = await loggedAdmin();
    const created = await postForm(admin, '/admin/grupos', '/admin/grupos', {
      nome: ' Concurso   TRF ',
    });
    const id = /^\/admin\/grupos\/([0-9a-f-]{36})$/.exec(created.headers.location ?? '')![1]!;
    const page = await admin.get(`/admin/grupos/${id}`);
    expect(page.text).toContain('Grupo Concurso TRF criado.');

    await addGroup('Matemática');
    const duplicate = await postForm(admin, '/admin/grupos', '/admin/grupos', {
      nome: 'matematica',
    });
    expect(duplicate.status).toBe(422);
    expect(duplicate.text).toContain('Já existe um grupo com esse nome.');

    const renamed = await postForm(admin, `/admin/grupos/${id}`, `/admin/grupos/${id}`, {
      nome: 'Concurso TRF 2027',
    });
    expect(renamed.headers.location).toBe(`/admin/grupos/${id}`);
    const list = (await admin.get('/admin/grupos')).text;
    expect(list).toContain('Concurso TRF 2027');
    expect(list.indexOf('Concurso TRF 2027')).toBeLessThan(list.indexOf('Matemática'));

    const [rows] = await ctx.pool.query('SELECT * FROM study_groups');
    expect(JSON.stringify(rows)).not.toMatch(/Concurso|Matem/);
  });

  it('adiciona só usuários ativos e remove membros', async () => {
    const { agent: admin } = await loggedAdmin();
    const ana = await addUser({ name: 'Ana Souza', email: 'ana@exemplo.com' });
    const bruno = await addUser({ name: 'Bruno Lima', email: 'bruno@exemplo.com' });
    const inactive = await addUser({ name: 'Carla Dias', email: 'carla@exemplo.com' });
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, inactive));
    const group = await addGroup('Concurso');
    const path = `/admin/grupos/${group}`;

    const page = (await admin.get(path)).text;
    expect(page).toContain('Ana Souza');
    expect(page).not.toContain('Carla Dias');

    const added = await postForm(admin, path, `${path}/membros`, {
      usuarios: [ana, bruno, inactive],
    });
    expect(added.headers.location).toBe(path);
    const members = await ctx.db
      .select()
      .from(studyGroupMembers)
      .where(eq(studyGroupMembers.groupId, group));
    expect(members.map((row) => row.userId).sort()).toEqual([ana, bruno].sort());
    expect((await admin.get(path)).text).toContain('2 membros adicionados.');
    expect((await admin.get('/admin/usuarios')).text).toContain('Concurso');

    await postForm(admin, path, `${path}/membros/${bruno}/remover`);
    const after = await ctx.db
      .select()
      .from(studyGroupMembers)
      .where(eq(studyGroupMembers.groupId, group));
    expect(after.map((row) => row.userId)).toEqual([ana]);
  });

  it('excluir é lógico: o grupo some da lista e a página passa a dar 404', async () => {
    const { agent: admin } = await loggedAdmin();
    const group = await addGroup('Concurso');
    const res = await postForm(admin, `/admin/grupos/${group}`, `/admin/grupos/${group}/excluir`);
    expect(res.headers.location).toBe('/admin/grupos');
    expect((await groupRow(group)).deletedAt).not.toBeNull();
    const list = (await admin.get('/admin/grupos')).text;
    expect(list).toContain('Grupo Concurso excluído.');
    expect(list).toContain('Nenhum grupo ainda');
    expect((await admin.get(`/admin/grupos/${group}`)).status).toBe(404);
  });

  it('usuário comum recebe 404 nas páginas de grupos', async () => {
    const { agent: user } = await loggedUser('Maria da Silva', 'maria@exemplo.com');
    const group = await addGroup('Concurso');
    expect((await user.get('/admin/grupos')).status).toBe(404);
    expect((await user.get(`/admin/grupos/${group}`)).status).toBe(404);
  });
});
