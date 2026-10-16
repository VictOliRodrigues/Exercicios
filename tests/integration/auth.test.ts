import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../../src/db/schema.js';
import { createUser, type NewUser } from '../../src/modules/users/users.service.js';
import { buildTestApp, csrfFrom, login, resetTables } from '../helpers/test-app.js';

const PASSWORD = 'senha-correta-123';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

beforeAll(async () => {
  ctx = await buildTestApp({ FORGOT_MAX_PER_HOUR: '100' });
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await resetTables(ctx.pool);
});

const agent = () => request.agent(ctx.app);

function addUser(overrides: Partial<NewUser> = {}) {
  return createUser(ctx.db, ctx.crypto, {
    name: 'Maria da Silva',
    email: 'maria@exemplo.com',
    phone: '48999990000',
    password: PASSWORD,
    role: 'user',
    mustChangePassword: false,
    ...overrides,
  });
}

async function userRow(id: string) {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
  return row!;
}

describe('páginas públicas', () => {
  it('/health responde ok', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('rota inexistente mostra a 404 personalizada com link para o login', async () => {
    const res = await request(ctx.app).get('/nao-existe');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Página não encontrada');
    expect(res.text).toContain('Ir para o login');
  });

  it('a página inicial sem login leva ao login', async () => {
    const res = await request(ctx.app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('formulário sem token CSRF mostra "sessão expirada"', async () => {
    const res = await request(ctx.app)
      .post('/login')
      .type('form')
      .send({ email: 'maria@exemplo.com', senha: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.text).toContain('Sua sessão expirou');
  });

  it('envia os cabeçalhos de segurança', async () => {
    const res = await request(ctx.app).get('/login');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('login', () => {
  it('senha errada e e-mail inexistente dão a mesma mensagem', async () => {
    await addUser();
    const wrongPassword = await login(agent(), 'maria@exemplo.com', 'senha-errada');
    const unknownEmail = await login(agent(), 'ninguem@exemplo.com', 'senha-errada');
    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.text).toContain('E-mail ou senha inválidos');
    }
  });

  it('login certo leva ao painel, sem diferenciar maiúsculas no e-mail', async () => {
    await addUser();
    const user = agent();
    const res = await login(user, ' MARIA@Exemplo.com ', PASSWORD);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    const painel = await user.get('/');
    expect(painel.status).toBe(200);
    expect(painel.text).toContain('Olá, Maria');
  });

  it('bloqueia depois de 5 falhas, mesmo com a senha certa em seguida', async () => {
    const id = await addUser();
    for (let i = 0; i < 5; i++) await login(agent(), 'maria@exemplo.com', 'senha-errada');
    const res = await login(agent(), 'maria@exemplo.com', PASSWORD);
    expect(res.status).toBe(401);
    expect((await userRow(id)).lockedUntil).not.toBeNull();
  });

  it('tentativas simultâneas não passam do limite antes do bloqueio', async () => {
    const id = await addUser();
    const attacker = agent();
    const _csrf = await csrfFrom(attacker, '/login');
    await Promise.all(
      Array.from({ length: 8 }, () =>
        attacker
          .post('/login')
          .type('form')
          .send({ _csrf, email: 'maria@exemplo.com', senha: 'senha-errada' }),
      ),
    );
    expect((await userRow(id)).lockedUntil).not.toBeNull();
    expect((await login(agent(), 'maria@exemplo.com', PASSWORD)).status).toBe(401);
  });

  it('a senha certa na última tentativa antes do bloqueio entra e zera a contagem', async () => {
    const id = await addUser();
    for (let i = 0; i < 4; i++) await login(agent(), 'maria@exemplo.com', 'senha-errada');
    expect((await login(agent(), 'maria@exemplo.com', PASSWORD)).status).toBe(302);
    const row = await userRow(id);
    expect(row.failedLogins).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it('usuário desativado não entra', async () => {
    const id = await addUser();
    await ctx.db.update(users).set({ active: false }).where(eq(users.id, id));
    const res = await login(agent(), 'maria@exemplo.com', PASSWORD);
    expect(res.status).toBe(401);
  });

  it('quem já está logado e abre /login vai para a página inicial', async () => {
    await addUser();
    const user = agent();
    await login(user, 'maria@exemplo.com', PASSWORD);
    const res = await user.get('/login');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('sair encerra a sessão', async () => {
    await addUser();
    const user = agent();
    await login(user, 'maria@exemplo.com', PASSWORD);
    const _csrf = await csrfFrom(user, '/');
    const res = await user.post('/logout').type('form').send({ _csrf });
    expect(res.headers.location).toBe('/login');
    expect((await user.get('/')).headers.location).toBe('/login');
  });
});

describe('troca de senha obrigatória', () => {
  it('admin do primeiro login precisa trocar a senha antes de abrir qualquer página', async () => {
    const id = await addUser({
      name: 'Administrador',
      email: 'admin@exemplo.com',
      role: 'admin',
      mustChangePassword: true,
    });
    const admin = agent();

    const res = await login(admin, 'admin@exemplo.com', PASSWORD);
    expect(res.headers.location).toBe('/alterar-senha');
    expect((await admin.get('/admin/usuarios')).headers.location).toBe('/alterar-senha');
    expect((await admin.get('/')).headers.location).toBe('/alterar-senha');

    const _csrf = await csrfFrom(admin, '/alterar-senha');
    const attempt = (senhaAtual: string, novaSenha: string, confirmacao = novaSenha) =>
      admin.post('/alterar-senha').type('form').send({ _csrf, senhaAtual, novaSenha, confirmacao });

    const wrongCurrent = await attempt('nao-e-essa', 'nova-senha-segura');
    expect(wrongCurrent.status).toBe(422);
    expect(wrongCurrent.text).toContain('A senha atual está incorreta.');
    expect((await attempt(PASSWORD, PASSWORD)).text).toContain('diferente da atual');
    expect((await attempt(PASSWORD, 'curta')).text).toContain('pelo menos 10 caracteres');
    expect((await attempt(PASSWORD, 'nova-senha-segura', 'outra-coisa')).text).toContain(
      'não confere',
    );

    const ok = await attempt(PASSWORD, 'nova-senha-segura');
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe('/admin/usuarios');
    const page = await admin.get('/admin/usuarios');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Senha alterada com sucesso.');
    expect((await userRow(id)).mustChangePassword).toBe(false);

    expect((await login(agent(), 'admin@exemplo.com', 'nova-senha-segura')).headers.location).toBe(
      '/admin/usuarios',
    );
  });

  it('trocar a senha encerra as outras sessões do usuário', async () => {
    await addUser();
    const phone = agent();
    const laptop = agent();
    await login(phone, 'maria@exemplo.com', PASSWORD);
    await login(laptop, 'maria@exemplo.com', PASSWORD);

    const _csrf = await csrfFrom(phone, '/alterar-senha');
    await phone.post('/alterar-senha').type('form').send({
      _csrf,
      senhaAtual: PASSWORD,
      novaSenha: 'nova-senha-segura',
      confirmacao: 'nova-senha-segura',
    });

    expect((await phone.get('/')).status).toBe(200);
    expect((await laptop.get('/')).headers.location).toBe('/login');
  });

  it('limita as tentativas com a senha atual errada', async () => {
    await addUser();
    const user = agent();
    await login(user, 'maria@exemplo.com', PASSWORD);
    const _csrf = await csrfFrom(user, '/alterar-senha');
    const attempt = () =>
      user.post('/alterar-senha').type('form').send({
        _csrf,
        senhaAtual: 'chute-errado',
        novaSenha: 'nova-senha-segura',
        confirmacao: 'nova-senha-segura',
      });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(422);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.text).toContain('Muitas tentativas');
  });
});

describe('perfis', () => {
  it('usuário comum recebe 404 nas páginas de admin', async () => {
    await addUser();
    const user = agent();
    await login(user, 'maria@exemplo.com', PASSWORD);
    const res = await user.get('/admin/usuarios');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Voltar ao painel');
  });

  it('admin que abre a página inicial vai para a lista de usuários', async () => {
    await addUser({ email: 'admin@exemplo.com', role: 'admin' });
    const admin = agent();
    await login(admin, 'admin@exemplo.com', PASSWORD);
    expect((await admin.get('/')).headers.location).toBe('/admin/usuarios');
  });
});

describe('esqueci minha senha', () => {
  async function requestReset(email: string) {
    const visitor = agent();
    const _csrf = await csrfFrom(visitor, '/esqueci-senha');
    return visitor.post('/esqueci-senha').type('form').send({ _csrf, email });
  }

  it('responde igual para e-mail cadastrado e não cadastrado, e registra só o pedido real', async () => {
    const id = await addUser();
    const known = await requestReset('maria@exemplo.com');
    const unknown = await requestReset('ninguem@exemplo.com');
    for (const res of [known, unknown]) {
      expect(res.status).toBe(200);
      expect(res.text).toContain('Pedido registrado');
    }
    expect((await userRow(id)).passwordResetRequestedAt).not.toBeNull();
  });

  it('mantém a data do primeiro pedido', async () => {
    const id = await addUser();
    await requestReset('maria@exemplo.com');
    const first = (await userRow(id)).passwordResetRequestedAt;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await requestReset('maria@exemplo.com');
    expect((await userRow(id)).passwordResetRequestedAt).toEqual(first);
  });

  it('pedido do admin não é registrado', async () => {
    const id = await addUser({ email: 'admin@exemplo.com', role: 'admin' });
    const res = await requestReset('admin@exemplo.com');
    expect(res.text).toContain('Pedido registrado');
    expect((await userRow(id)).passwordResetRequestedAt).toBeNull();
  });

  it('e-mail inválido mostra erro', async () => {
    const res = await requestReset('isso-nao-e-email');
    expect(res.status).toBe(422);
    expect(res.text).toContain('Informe um e-mail válido.');
  });
});

describe('dados no banco', () => {
  it('nome, e-mail e telefone ficam criptografados', async () => {
    await addUser();
    const [rows] = await ctx.pool.query('SELECT * FROM users');
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain('Maria');
    expect(raw).not.toContain('maria@exemplo.com');
    expect(raw).not.toContain('48999990000');
    expect(raw).toMatch(/"email_idx":"[0-9a-f]{64}"/);
    expect(raw).toContain('$argon2id$');
  });
});
