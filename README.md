# Simulados

Sistema web para fazer simulados de múltipla escolha a partir de arquivos `.md`. O plano completo, com as regras e as decisões, está em [PLANO.md](PLANO.md).

Stack: Node.js 24 + TypeScript, Express 5, EJS, MySQL 8.4 com Drizzle ORM.

## Rodar localmente

Requisitos: Node.js 24 e Docker.

1. Instale as dependências:
   ```sh
   npm install
   ```
2. Crie o `.env` a partir do modelo e preencha:
   ```sh
   cp .env.example .env
   npm run keys:generate   # gera ENCRYPTION_KEY e SESSION_SECRET
   ```
   Para desenvolvimento, use `NODE_ENV=development`, `TRUST_PROXY=0`, `STORAGE_PATH=./storage` e aponte `DATABASE_URL` para `127.0.0.1:3307` (a porta do MySQL do docker-compose). Defina também as senhas `MYSQL_*`, o `TEST_DATABASE_URL` (com o usuário root) e os dados do admin (`ADMIN_*`).
3. Suba o MySQL, aplique as migrations e crie o admin:
   ```sh
   docker compose up -d mysql
   npm run db:migrate
   npm run seed:admin
   ```
4. Inicie o servidor e abra http://localhost:3000:
   ```sh
   npm run dev
   ```
   Entre com `ADMIN_EMAIL` e `ADMIN_PASSWORD`. A troca de senha é obrigatória no primeiro login.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | servidor com recarga automática |
| `npm test` | testes unitários e de integração (precisa do MySQL rodando) |
| `npm run typecheck` / `npm run lint` | verificação de tipos e lint |
| `npm run build` / `npm start` | build de produção e execução |
| `npm run db:generate` | gera uma migration depois de mudar `src/db/schema.ts` |
| `npm run db:migrate` | aplica as migrations |
| `npm run seed:admin` | cria o admin, se ainda não existir |
| `npm run keys:generate` | gera chaves novas |
| `npm run admin:reset-password` | gera uma senha temporária para o admin (roda sobre o build, no container) |

Os testes de integração usam o banco de `TEST_DATABASE_URL`, que precisa terminar em `_test` e é apagado entre um teste e outro.

## Testar a imagem Docker localmente

```sh
docker compose --profile app up --build
```

O app sobe em modo produção em http://localhost:3000, com `COOKIE_SECURE=false` para funcionar sem HTTPS.

## Deploy no Coolify

1. Crie um recurso **MySQL 8** e, nele, o database e o usuário da aplicação. Ligue os backups agendados.
2. Crie a aplicação a partir deste repositório, com build pack **Dockerfile**.
3. Em *Environment Variables*, cole as variáveis do `.env.example` preenchidas (`NODE_ENV=production`, `TRUST_PROXY=1`, `DATABASE_URL` com a URL interna do MySQL). Nenhuma deve ser *Build Variable*.
4. Em *Persistent Storage*, monte um volume em `/app/storage`.
5. Configure o domínio. O HTTPS é automático.
6. Healthcheck: `GET /health` na porta 3000.

Na subida, o container aplica as migrations e cria o admin, se ainda não existir.

**Guarde a `ENCRYPTION_KEY` fora do servidor.** Sem ela, os dados criptografados não podem ser recuperados.

Se o admin esquecer a senha, rode no terminal do container (Coolify → Terminal):

```sh
npm run admin:reset-password
```
