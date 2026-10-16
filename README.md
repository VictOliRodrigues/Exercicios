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
| `npm run data:check` | confere se banco, volume e `ENCRYPTION_KEY` combinam, depois de restaurar um backup (roda sobre o build) |

Os testes de integração usam o banco de `TEST_DATABASE_URL`, que precisa terminar em `_test` e é apagado entre um teste e outro.

## Testar a imagem Docker localmente

```sh
docker compose --profile app up --build
```

O app sobe em modo produção em http://localhost:3000, com `COOKIE_SECURE=false` para funcionar sem HTTPS.

## Deploy no Coolify

1. Crie um recurso **MySQL 8**, no mesmo projeto e servidor da aplicação. Use o usuário comum que o Coolify cria junto com o database inicial (ele só tem acesso a esse database), nunca o root. Ligue os backups agendados, de preferência enviando para um S3.
2. Crie a aplicação a partir deste repositório, com build pack **Dockerfile**.
3. Gere as chaves na sua máquina com `npm run keys:generate` e **guarde a `ENCRYPTION_KEY` num gerenciador de senhas**, fora do servidor.
4. Em *Environment Variables*, cole as variáveis do `.env.example` preenchidas: `NODE_ENV=production`, `TRUST_PROXY=1`, `DATABASE_URL` com a URL interna do MySQL, as chaves e os dados do admin. Nenhuma deve ser *Build Variable*, porque segredo não pode ir para dentro da imagem. Não defina `COOKIE_SECURE` nem as variáveis `MYSQL_*` e `TEST_DATABASE_URL`, que são só do ambiente local.
5. Em *Persistent Storage*, monte um volume em `/app/storage`.
6. Configure o domínio. O HTTPS é automático (Let's Encrypt).
7. Healthcheck: `GET /health` na porta 3000.
8. Faça o deploy e entre com `ADMIN_EMAIL` e `ADMIN_PASSWORD`. O sistema pede a troca da senha. Depois disso, a `ADMIN_PASSWORD` pode ser apagada das variáveis.

Na subida, o container aplica as migrations e cria o admin, se ainda não existir. Os dois passos são idempotentes, então todo redeploy repete os dois sem efeito.

`TRUST_PROXY` é o número de proxies na frente do app. No Coolify é 1 (o Traefik). Se houver mais um na frente, como o Cloudflare com proxy ligado, use 2. Com o valor errado, o limite de tentativas de login passa a contar todo mundo como um IP só.

Se o admin esquecer a senha, rode no terminal do container (Coolify → Terminal):

```sh
npm run admin:reset-password
```

### Antes de cada deploy

```sh
npm audit --omit=dev   # dependências de produção: precisa dar 0 vulnerabilidades
npm run typecheck && npm run lint && npm test
```

O `npm audit` sem `--omit=dev` acusa o `esbuild` antigo que o `drizzle-kit` usa. Ele só roda na sua máquina, no `npm run db:generate`, e não vai para a imagem.

## Backups

São três coisas, e a chave fica **separada** das outras duas: um backup do banco sem a chave é inútil, e guardar a chave junto do backup anula a criptografia.

| O quê | Como | Para quê |
|---|---|---|
| Banco MySQL | backups agendados do Coolify | todos os dados: usuários, grupos, questões, tentativas e relatórios |
| Volume `/app/storage` | cópia da pasta `banks/` (veja abaixo) | os arquivos `.md` originais, criptografados. O sistema funciona sem eles, porque as questões ficam no banco |
| `ENCRYPTION_KEY` | gerenciador de senhas | sem ela, nada do banco nem do volume pode ser lido |

Para copiar o volume, rode no servidor (o nome do volume aparece em *Persistent Storage*):

```sh
docker run --rm -v NOME_DO_VOLUME:/data:ro -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/simulados-storage-$(date +%F).tar.gz -C /data .
```

### Restaurar

1. Restaure o dump do banco no MySQL (pelo Coolify ou com `mysql ... < dump.sql`).
2. Se precisar, restaure o volume: `tar xzf simulados-storage-AAAA-MM-DD.tar.gz -C /data` num container com o volume montado, como no comando acima, sem o `:ro`.
3. Confira se a `ENCRYPTION_KEY` e a `ENCRYPTION_KEY_VERSION` da aplicação são as mesmas da época do backup e faça o redeploy.
4. No terminal do container, confira se tudo pode ser lido:
   ```sh
   npm run data:check
   ```
   O comando decifra todos os campos do banco e todos os arquivos do volume e mostra só contagens. Se algo falhar, ele lista os ids e termina com erro: normalmente é a chave errada ou um volume de outra época.
