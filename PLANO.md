# Plano: Sistema de Simulados

> Versão 4, 15/10/2026, já com as suas respostas.
> Todas as decisões estão registradas na [seção 16](#16-registro-de-decisões). Não há pontos em aberto.

---

## 1. Objetivo

Aplicação web simples para fazer simulados a partir de arquivos `.md` com questões de múltipla escolha. As questões são geradas no ChatGPT a partir de anotações, usando o modelo e o prompt que o próprio sistema oferece para download.

Cada usuário importa os próprios arquivos e decide, na importação, se o simulado fica **privado** ou é **compartilhado com um ou mais dos seus grupos de estudo**. O admin cria os usuários e os grupos e define quem participa de cada grupo.

Os grupos servem só para compartilhar questões. Cada pessoa faz o simulado do seu jeito, quantas vezes quiser, com respostas e relatórios individuais. Quem já fez um simulado compartilhado fica com ele, mesmo que o compartilhamento acabe.

Na prova, o usuário clica em **Iniciar** (o cronômetro começa), responde 10 questões por página e clica em **Finalizar**. Em seguida vê o relatório com o tempo, os acertos, os erros, uma nota de 0 a 10 e as questões que errou, com a alternativa marcada e a correta.

O sistema é usado pelo navegador e fica hospedado no Coolify. Rodar na máquina local serve só para desenvolvimento.

```
Login ─► Painel ─► Importar .md (privado ou grupos) ─► Opções ─► [Iniciar] ─► Prova (10 por página + cronômetro) ─► [Finalizar] ─► Relatório
```

---

## 2. Perfis e escopo

**Admin** (criado por seed; não importa questões nem faz simulados)
- **Usuários**: criar, editar, desativar e redefinir senha. Os pedidos de "Esqueci minha senha" aparecem no topo da lista.
- **Grupos de estudo**: criar, renomear e excluir grupos, além de adicionar e remover membros. O admin não vê o conteúdo dos simulados nem os resultados.

**Usuário**
- Importar `.md`, escolhendo entre privado e um ou mais dos seus grupos, e baixar o modelo e o prompt do ChatGPT.
- Ver os próprios simulados, os que os outros membros compartilharam nos seus grupos e os que já fez.
- Fazer qualquer um deles quantas vezes quiser, com opções próprias. Relatórios e histórico são sempre individuais.
- Alterar a própria senha e pedir redefinição quando esquecer.

**Fora do escopo:** cadastro público, explicação por questão, refazer só as erradas, gráfico de evolução e imagens nas questões (por enquanto).

---

## 3. Stack

| Camada | Escolha | Motivo |
|---|---|---|
| Runtime | Node.js 24 LTS + TypeScript | LTS atual, tipagem |
| HTTP | Express 5 | simples, sem cerimônia |
| Páginas | EJS renderizado no servidor + JS puro (cronômetro, mapa de questões, salvamento automático) | sem build de front, um container só |
| Banco | MySQL 8.4 + Drizzle ORM (migrations com drizzle-kit) | leve, SQL explícito |
| Markdown | `remark-parse` + `remark-gfm` → `remark-rehype` → `rehype-sanitize` → `rehype-stringify` | a árvore GFM já informa se cada item `- [x]` está marcado; a sanitização remove XSS |
| Senhas | Argon2id (pacote `argon2`) | padrão atual para hash de senha |
| Criptografia | `node:crypto` (AES-256-GCM, HKDF, HMAC) | nativo, sem dependência |
| Sessão | `express-session` + `express-mysql-session` | sessão no banco |
| Segurança HTTP | `helmet` (CSP), `express-rate-limit`, `csrf-sync` | |
| Upload | `multer` (em memória, limite de 1 MB) | |
| Validação | `zod` (`.env` e formulários) | |
| Testes | `vitest` + `supertest` | |

Convenção: versões exatas no `package.json`, sem `^` nem `~` (`npm install --save-exact`).

---

## 4. Arquivo de questões

### 4.1 Modelo e prompt

Dois arquivos de apoio já estão prontos na pasta [modelos/](modelos/):

| Arquivo | Para que serve |
|---|---|
| [modelos/modelo-questoes.md](modelos/modelo-questoes.md) | Simulado de exemplo com 5 questões que usam todos os recursos do formato (código, lista de afirmativas, tabela). Pode ser importado direto para testar o sistema. |
| [modelos/prompt-chatgpt.txt](modelos/prompt-chatgpt.txt) | Prompt para colar no ChatGPT junto com as anotações. Basta trocar a quantidade e colar as anotações no final. |

No sistema, a tela de importação tem o botão **Baixar modelo (.md)** e mostra o prompt numa caixa com o botão **Copiar prompt**, além de um link para baixá-lo. O prompt é `.txt` de propósito, para não ser confundido com um arquivo de questões na hora de importar.

### 4.2 Formato

A alternativa correta é marcada com a **lista de tarefas do Markdown**: `- [ ]` para as erradas e `- [x]` para a correta.

````markdown
# Título do simulado

## Questão 1
Enunciado da questão. Pode ter **negrito**, `código`, tabelas, listas e blocos de código.

- [ ] alternativa errada
- [x] alternativa correta
- [ ] alternativa errada
- [ ] alternativa errada
````

| Elemento | Regra |
|---|---|
| `# Título` | Opcional, só no topo. Vira o nome do simulado. Sem ele, o sistema usa o nome do arquivo. |
| `## ...` | Começa uma questão. O sistema numera sozinho. |
| Enunciado | Tudo o que fica entre o `##` e as alternativas. Não pode ser vazio. Se não houver nada entre os dois, o texto do próprio `##` vira o enunciado. |
| Alternativas | A **última** lista de tarefas da questão: **exatamente 4 itens** e **exatamente 1** marcado com `[x]` (ou `[X]`). |
| Ordem das alternativas | O sistema **embaralha** as alternativas. Por isso, uma alternativa como "todas as anteriores", "nenhuma das anteriores" ou "alternativas A e B" é **erro de importação**. |
| Texto depois das alternativas | É ignorado e gera um aviso (não bloqueia a importação). Cobre o caso de o ChatGPT acrescentar gabarito ou explicação. |
| Texto antes da 1ª questão | É ignorado e gera um aviso. |
| HTML cru | É removido, por segurança. |
| Imagens | Não são suportadas. |

**O parser também aceita:** UTF-8 com ou sem BOM, quebras de linha do Windows (CRLF), marcadores `-`, `*` ou `+` e espaços extras. Como a leitura é feita pela árvore do Markdown, um `- [x]` dentro de bloco de código não é confundido com alternativa.

### 4.3 Validação e mensagem para o ChatGPT

A importação é **tudo ou nada**: se houver qualquer erro, nada é salvo. A tela de erro tem duas partes.

**1. Lista para o usuário**, com o número da questão e a linha do arquivo:

- `Questão 3 (linha 27): encontrei 3 alternativas, esperado 4.`
- `Questão 5 (linha 41): nenhuma alternativa marcada como correta.`
- `Questão 8 (linha 70): 2 alternativas marcadas como corretas.`
- `Questão 9 (linha 82): enunciado vazio.`
- `Questão 11 (linha 97): a alternativa "Todas as anteriores" depende da ordem.`
- `Nenhuma questão encontrada (cada questão começa com ##).`

**2. Mensagem pronta para o ChatGPT**, numa caixa com o botão **Copiar mensagem**. O ChatGPT não enxerga números de linha, então cada problema traz o número da questão e o começo do enunciado:

```text
O arquivo .md que você gerou não pôde ser importado no sistema de simulados. Problemas encontrados:

1. Questão 3 ("Qual é a função do método map…"): tem 3 alternativas; precisa ter exatamente 4.
2. Questão 5 ("Sobre o protocolo HTTP, é correto…"): nenhuma alternativa marcada como correta; marque exatamente uma com - [x].
3. Questão 11 ("Assinale a alternativa que…"): a alternativa "Todas as anteriores" depende da ordem, mas o sistema embaralha as alternativas; troque por outra.

Corrija apenas esses problemas, sem alterar as outras questões, e me envie novamente o arquivo .md COMPLETO, com todas as questões, seguindo as mesmas regras de formato:
- # Título na primeira linha;
- cada questão começa com ## Questão N;
- enunciado, linha em branco e 4 alternativas no formato - [ ] texto, com a correta como - [x] texto;
- nada de HTML, imagens ou texto depois das alternativas.
```

Problemas no arquivo em si (maior que 1 MB, fora de UTF-8 ou com extensão diferente de `.md`) aparecem só para o usuário, sem mensagem para o ChatGPT.

---

## 5. Fluxos

### 5.1 Login
1. O usuário informa **e-mail** e senha. O e-mail é o login.
2. O servidor calcula o índice de busca do e-mail ([seção 8.4](#84-busca-por-dado-criptografado)), localiza o registro e verifica a senha com Argon2.
3. Se der certo, a sessão é regenerada. Se a conta tiver `must_change_password` ativo, o usuário vai para `/alterar-senha`. Caso contrário, o admin vai para `/admin/usuarios` e o usuário vai para `/`.
4. Se falhar, ou se a conta estiver desativada, aparece a mensagem genérica "E-mail ou senha inválidos". Há limite de tentativas por IP e bloqueio de 15 min após 5 falhas no mesmo e-mail.

### 5.2 Esqueci minha senha
1. A tela de login tem o link **Esqueci minha senha**, que abre um formulário com um campo: o e-mail.
2. Se encontrar um usuário ativo, o servidor grava `password_reset_requested_at`. Se já houver um pedido aberto, a data original é mantida.
3. A resposta é **sempre a mesma**, exista o e-mail ou não: "Pedido registrado. Se o e-mail estiver correto, o administrador vai redefinir sua senha e enviar a nova para você."
4. Há limite de pedidos por IP (5 por hora).
5. Na lista de usuários do admin, quem pediu aparece **no topo**, com o selo **Esqueceu a senha** e a data do pedido. Telefone e e-mail ficam visíveis, para o admin entrar em contato.
6. O admin clica em **Redefinir senha** e digita uma senha temporária ou clica em **Gerar**, que cria 12 caracteres aleatórios exibidos uma única vez para copiar.
7. Ao salvar, o sistema grava o novo hash, ativa `must_change_password`, limpa o pedido, zera o bloqueio e o contador de falhas e **derruba todas as sessões** do usuário.
8. O admin envia a senha por fora do sistema (WhatsApp, e-mail etc.).

**Se o admin esquecer a própria senha:** no terminal do container (Coolify → Terminal), o comando `npm run admin:reset-password` gera uma senha temporária e ativa a troca obrigatória. Pelo formulário, um pedido vindo do admin não é registrado, mas a resposta continua sendo a mesma.

### 5.3 Troca de senha obrigatória
- Enquanto `must_change_password` estiver ativo, **qualquer página** redireciona para `/alterar-senha`.
- Isso acontece em três casos:
  - o admin do seed, no primeiro login;
  - o usuário recém-criado, porque a senha inicial também foi enviada por fora;
  - o usuário que teve a senha redefinida.
- O formulário pede senha atual, nova senha e confirmação. A nova senha precisa ter pelo menos 10 caracteres e ser diferente da atual.
- Ao trocar, a flag é desligada, as outras sessões do usuário caem e a sessão atual é regenerada.
- A mesma página serve para a troca voluntária, acessível pelo menu.

### 5.4 Admin: usuários
- **Lista**, nesta ordem: pedidos de redefinição no topo, depois os ativos por nome e por fim os desativados. As colunas são nome, e-mail, telefone, grupos, último login e situação.
- **Criar**: nome completo, e-mail (que é o login), telefone e senha inicial (digitada ou gerada).
  - O e-mail precisa ser válido e único.
  - O telefone precisa ter DDD (10 ou 11 dígitos). É guardado só com números e exibido formatado.
- **Editar**: nome, e-mail e telefone. A tela avisa que trocar o e-mail troca o login do usuário.
- **Desativar ou reativar**: quem está desativado não consegue logar e tem as sessões derrubadas, mas os dados e o histórico ficam.
- **Redefinir senha**: conforme a [seção 5.2](#52-esqueci-minha-senha).
- Não existe exclusão de usuário, para preservar o histórico.

### 5.5 Admin: grupos de estudo
- **Lista de grupos**, com nome, número de membros e número de simulados compartilhados, e o botão **Criar grupo**, que pede só o nome.
- **Página do grupo**, onde o admin pode renomear o grupo, **adicionar membros** (escolhendo entre os usuários ativos) e **remover membros**.
- O admin não importa, não abre e não exclui simulados. Ele só vê quantos existem em cada grupo.
- Um usuário pode participar de vários grupos.
- **Remover membro** e **excluir grupo** encerram compartilhamentos, conforme a [seção 5.7](#57-compartilhamento-em-grupos). A exclusão de grupo é lógica.

### 5.6 Importar `.md`
1. Na tela de importação, o usuário escolhe o arquivo e marca com quais grupos quer compartilhar, numa lista com os grupos de que participa. Sem nenhum marcado, o simulado fica **privado** (padrão).
2. O servidor checa tamanho, extensão e UTF-8 e confere se o usuário realmente participa de todos os grupos marcados.
3. O parser monta as questões. Se houver erro, nada é gravado e aparece a tela da [seção 4.3](#43-validação-e-mensagem-para-o-chatgpt), com a mensagem pronta para o ChatGPT.
4. O enunciado e as alternativas de cada questão viram HTML sanitizado.
5. O arquivo original é criptografado e gravado em `STORAGE_PATH/banks/<uuid>.enc`, com nome aleatório. A gravação usa um arquivo temporário seguido de `rename`, que é atômico.
6. Uma única transação insere `question_banks`, `question_bank_groups` e `questions`, com o conteúdo criptografado. Se a transação falhar, o arquivo é apagado.
7. A página do simulado mostra "42 questões importadas" e, se houver, os avisos (por exemplo, "Questão 4: o texto depois das alternativas foi ignorado").

### 5.7 Compartilhamento em grupos
- Um simulado é **privado** ou fica **compartilhado com um ou mais grupos** de que o dono participa.
- O simulado continua sendo de quem o enviou. **Só o dono** pode excluí-lo ou mudar o compartilhamento: na página do simulado, o campo **Compartilhar com** lista os grupos de que ele participa, em caixas de seleção. Sem nenhum marcado, o simulado fica privado.
- O painel do usuário tem:
  - **Meus simulados**: os que ele enviou, com a etiqueta "Privado" ou "Compartilhado com <grupos>", e os que ele já fez mas não estão mais compartilhados com nenhum grupo dele, com a etiqueta "Recebido de <nome>";
  - **uma seção para cada grupo**: os simulados enviados pelos outros membros, com "Enviado por <nome>". Um simulado compartilhado com dois grupos da pessoa aparece nas duas seções.
- Cada membro faz o simulado com as próprias opções, quantas vezes quiser. Ninguém vê o resultado dos outros, nem o admin.

**Quem já fez fica com o simulado.** Quem tem pelo menos uma tentativa de um simulado compartilhado continua com acesso a ele quando o compartilhamento acaba. O simulado passa para **Meus simulados** dessa pessoa, como privado e com a etiqueta "Recebido de <nome>", e ela pode refazê-lo quando quiser. Ela não pode compartilhar nem excluir esse simulado, porque não é a autora. Quem nunca fez perde o acesso.

O compartilhamento acaba nestes casos:

| Situação | Quem perde o acesso pelo grupo |
|---|---|
| O dono desmarca um grupo | os membros desse grupo |
| O dono é removido de um grupo | os membros desse grupo, para todos os simulados do dono (que continuam nos outros grupos dele) |
| Um membro é removido de um grupo | esse membro, para todos os simulados do grupo |
| O grupo é excluído | todos os membros; o simulado que ficar sem nenhum grupo volta a ser privado do dono |
| O dono exclui o simulado (exclusão lógica) | o dono e todos os membros dos grupos |

Em todos os casos, quem já fez continua com o simulado, e as tentativas e os relatórios de todo mundo são preservados.

### 5.8 Iniciar simulado
A página do simulado mostra:
- título, número de questões e origem ("Privado", "Compartilhado com <grupos>", "Enviado por <nome> em <grupo>" ou "Recebido de <nome>");
- **Suas tentativas**: data, nota e tempo de cada uma, com link para o relatório. As que estão em andamento aparecem com **Continuar** e **Descartar** (descartar apaga a tentativa não finalizada, depois de confirmar);
- duas opções:
  - **Quantidade de questões**: todas (padrão) ou um número menor, sorteado aleatoriamente;
  - **Tempo limite**: sem limite (padrão) ou um número de minutos;
- o botão **Iniciar novo simulado**.

O usuário pode fazer o mesmo simulado **quantas vezes quiser**. Iniciar uma tentativa nova não mexe nas que estão em andamento.

O botão **Iniciar novo simulado**:
1. sorteia as questões, se o usuário escolheu um número menor;
2. **embaralha a ordem das questões e as alternativas de cada uma** (sempre ligado);
3. numera as questões de 1 a N (o número de cada questão não muda mais) e distribui em páginas de 10;
4. grava `started_at` com a hora **do servidor** e, se houver tempo limite, `deadline_at`.

Cada tentativa tem sorteio, ordem e opções próprios. A ordem fica gravada para o relatório mostrar as letras como o usuário viu.

### 5.9 Fazer a prova
- Cada página mostra **10 questões**, com enunciado e 4 alternativas em radio (A–D, na ordem embaralhada). **O HTML da prova não contém o gabarito.**
- Uma barra fixa mostra:
  - o tempo decorrido (`hh:mm:ss`);
  - o tempo restante, se houver limite (fica vermelho nos últimos 5 minutos);
  - "Página 2 de 5";
  - "14/50 respondidas".
- O **mapa de questões** é uma grade de 1 a N que diferencia as respondidas das em branco. Clicar num número leva à página da questão e rola a tela até ela. No celular, o mapa fica recolhível.
- Cada clique numa alternativa é salvo na hora via `fetch`. Os botões **Anterior** e **Próxima** também enviam o formulário da página, então as respostas são salvas mesmo se o `fetch` falhar. O usuário pode voltar às páginas anteriores quando quiser.
- O cronômetro parte dos segundos que o servidor informa. Recarregar a página não zera o tempo nem perde respostas, e o cronômetro não tem pausa.
- O botão **Finalizar** fica na última página.

### 5.10 Finalizar com questões em branco
1. **Finalizar** envia a página atual, que é salva, e o servidor verifica se há questões em branco.
2. Se não houver nenhuma, o simulado é finalizado.
3. Se houver, aparece uma tela de confirmação: "Você deixou 7 questões em branco (3, 8, 12, 15, 19, 21, 24). Questões em branco contam como erradas. Deseja finalizar mesmo assim?", com os botões **Sim, finalizar** e **Não, responder as em branco**.
4. **Não, responder as em branco** reorganiza a prova:
   - as questões respondidas continuam primeiro, na ordem em que estavam;
   - as em branco vão **para o final, começando numa página nova**, em páginas de 10;
   - o usuário é levado à primeira página das em branco;
   - os números das questões não mudam (a "Questão 8" continua sendo 8);
   - o cronômetro continua correndo.

   Exemplo: numa prova de 25 questões com 7 em branco, as páginas 1 e 2 ficam com as 18 respondidas (10 + 8) e a página 3 com as 7 em branco.
5. A última página volta a ter **Finalizar**, e o ciclo se repete enquanto houver questões em branco.
6. **Sim, finalizar** encerra o simulado, e as questões em branco contam como erradas.

O `POST /finalizar` é idempotente: se o simulado já foi finalizado, ele só redireciona. Depois de finalizado, as respostas não mudam mais, e a URL da prova redireciona para o relatório.

### 5.11 Tempo limite
- Quando o tempo restante chega a zero, a página envia **Finalizar** automaticamente, sem tela de confirmação, e as questões em branco contam como erradas.
- O servidor também garante o limite:
  - respostas enviadas depois do `deadline_at` (com 5 s de tolerância para a rede) são recusadas;
  - qualquer acesso a um simulado vencido finaliza o simulado com `finished_at = deadline_at`, o que cobre o caso de o navegador ter sido fechado.
- O relatório mostra "Encerrado por tempo esgotado".

### 5.12 Relatório
- **Tempo total**: `finished_at − started_at`, medido pelo relógio do servidor. Se houver tempo limite, ele também aparece.
- **Acertos**, **Erros** (as em branco entram aqui, ex.: "Erros: 6, sendo 2 em branco") e **Total**.
- **Nota** = `acertos ÷ total × 10`, armazenada com 2 casas e exibida com 1 (7,78 vira 7,8). Também aparece o percentual de acerto.
- **Como terminou**: finalizado pelo usuário ou por tempo esgotado.
- **Questões erradas e em branco**, na ordem dos números: número, enunciado, "Sua resposta: B) …" em vermelho (ou "Em branco") e "Correta: D) …" em verde. As letras são as que o usuário viu nessa tentativa.
- **Histórico** no painel: data, simulado, nota e tempo, com link para o relatório. Cada tentativa aparece separada.

---

## 6. Telas e rotas

| Método | Rota | Perfil | Função |
|---|---|---|---|
| GET/POST | `/login` | público | login com e-mail e senha |
| GET/POST | `/esqueci-senha` | público | pedido de redefinição |
| GET | `/health` | público | healthcheck (testa o banco) |
| POST | `/logout` | logado | encerra a sessão |
| GET/POST | `/alterar-senha` | logado | troca de senha (obrigatória ou voluntária) |
| GET | `/modelos/modelo-questoes.md` | usuário | baixar o modelo |
| GET | `/modelos/prompt-chatgpt.txt` | usuário | baixar o prompt |
| GET/POST | `/admin/usuarios` | admin | lista + criação |
| GET/POST | `/admin/usuarios/:id` | admin | editar dados |
| POST | `/admin/usuarios/:id/ativo` | admin | desativar ou reativar |
| GET/POST | `/admin/usuarios/:id/redefinir-senha` | admin | redefinir senha |
| GET/POST | `/admin/grupos` | admin | lista + criação |
| GET/POST | `/admin/grupos/:id` | admin | página do grupo, renomear |
| POST | `/admin/grupos/:id/excluir` | admin | excluir grupo |
| POST | `/admin/grupos/:id/membros` | admin | adicionar membros |
| POST | `/admin/grupos/:id/membros/:userId/remover` | admin | remover membro |
| GET | `/` | usuário | painel: meus simulados, uma seção por grupo, em andamento, histórico |
| GET | `/bancos/importar` | usuário | upload com escolha de grupos + modelo + prompt |
| POST | `/bancos` | usuário | importa `.md` |
| GET | `/bancos/:id` | usuário | detalhes, suas tentativas, opções, Iniciar |
| POST | `/bancos/:id/compartilhamento` | dono | escolher os grupos (nenhum = privado) |
| POST | `/bancos/:id/excluir` | dono | excluir |
| POST | `/bancos/:id/simulados` | usuário | **Iniciar novo simulado** |
| GET | `/simulados/:id?pagina=N` | usuário | prova |
| POST | `/simulados/:id/pagina` | usuário | salva a página e navega |
| PUT | `/api/simulados/:id/respostas/:questaoId` | usuário | salvamento automático (JSON) |
| POST | `/simulados/:id/finalizar` | usuário | finaliza ou mostra a confirmação de em branco |
| POST | `/simulados/:id/reorganizar` | usuário | "Não, responder as em branco" |
| POST | `/simulados/:id/descartar` | usuário | descarta tentativa em andamento |
| GET | `/simulados/:id/relatorio` | usuário | relatório |

### Páginas de erro
- **404 personalizada**: mensagem amigável ("Página não encontrada"), um texto curto e o botão **Voltar ao painel**, ou **Ir para o login** para quem não está logado. Ela aparece para:
  - rotas que não existem;
  - simulados privados e tentativas de outro usuário;
  - simulados de grupos dos quais o usuário não participa e que ele nunca fez;
  - ações de dono (excluir ou mudar o compartilhamento) feitas por quem não é o dono;
  - rotas de admin acessadas por usuário e vice-versa.

  Responder 404 em vez de 403 não revela o que existe.
- **500**: mensagem genérica ("Algo deu errado"), sem detalhe técnico, com um código de referência que também vai para o log.

---

## 7. Modelo de dados

Os IDs são **UUID v7** gerados na aplicação, em `CHAR(36)`. Eles são ordenáveis por tempo, não ficam sequenciais na URL e já existem antes do `INSERT`, o que é necessário para o AAD da [seção 8.2](#82-formato-do-dado-criptografado). As colunas `*_enc` guardam texto criptografado em base64, e as colunas `*_idx` guardam o índice de busca.

### `users`
| Coluna | Tipo | Observação |
|---|---|---|
| `id` | CHAR(36) PK | |
| `email_idx` | CHAR(64) UNIQUE | índice de busca do e-mail (login) |
| `email_enc` | TEXT | |
| `name_enc` | TEXT | nome completo |
| `phone_enc` | TEXT NULL | só dígitos; NULL só para o admin |
| `password_hash` | VARCHAR(255) | Argon2id |
| `role` | ENUM('admin','user') | |
| `active` | BOOLEAN | padrão `true` |
| `must_change_password` | BOOLEAN | padrão `true` |
| `password_reset_requested_at` | DATETIME NULL | pedido de "Esqueci minha senha" |
| `session_version` | INT | incrementado para derrubar sessões |
| `failed_logins` | INT | padrão 0 |
| `locked_until` | DATETIME NULL | bloqueio temporário |
| `last_login_at` | DATETIME NULL | |
| `created_at`, `updated_at` | DATETIME | |

### `study_groups`
| Coluna | Tipo | Observação |
|---|---|---|
| `id` | CHAR(36) PK | |
| `name_enc` | TEXT | |
| `created_at`, `updated_at` | DATETIME | |
| `deleted_at` | DATETIME NULL | exclusão lógica |

### `study_group_members`
| Coluna | Tipo | Observação |
|---|---|---|
| `group_id` | FK → study_groups | PK composta |
| `user_id` | FK → users | PK composta |
| `added_at` | DATETIME | |

### `question_banks` (um registro por arquivo importado)
| Coluna | Tipo | Observação |
|---|---|---|
| `id` | CHAR(36) PK | |
| `user_id` | FK → users | dono (quem enviou) |
| `title_enc` | TEXT | |
| `original_name_enc` | TEXT | |
| `storage_key` | CHAR(36) | nome do arquivo no volume |
| `question_count` | INT | |
| `created_at`, `updated_at` | DATETIME | |
| `deleted_at` | DATETIME NULL | exclusão lógica: o simulado some da lista, mas o histórico continua |

Índice: `(user_id)`.

### `question_bank_groups` (grupos com que o simulado está compartilhado)
| Coluna | Tipo | Observação |
|---|---|---|
| `bank_id` | FK → question_banks | PK composta |
| `group_id` | FK → study_groups | PK composta; índice próprio |
| `shared_at` | DATETIME | |

Sem nenhuma linha nesta tabela, o simulado é privado. As linhas são apagadas quando o dono desmarca o grupo, quando o dono sai do grupo e quando o grupo é excluído.

**Quem pode abrir um simulado** (uma única função de permissão, usada em todas as rotas):
1. o dono, se o simulado não estiver excluído;
2. um membro de um dos grupos em `question_bank_groups`, se o simulado e o grupo não estiverem excluídos;
3. qualquer outra pessoa com pelo menos uma tentativa nesse simulado, mesmo que ele tenha sido excluído pelo dono.

### `questions`
| Coluna | Tipo | Observação |
|---|---|---|
| `id` | CHAR(36) PK | |
| `bank_id` | FK → question_banks | |
| `position` | INT | ordem no arquivo (1..N) |
| `payload_enc` | MEDIUMTEXT | JSON criptografado: `{ statementHtml, options[4], correct (0–3), sourceLine }` |

### `attempts` (tentativas)
| Coluna | Tipo | Observação |
|---|---|---|
| `id` | CHAR(36) PK | aparece na URL |
| `user_id` | FK → users | sempre individual |
| `bank_id` | FK → question_banks | |
| `status` | ENUM('in_progress','finished') | |
| `total_questions` | INT | |
| `time_limit_seconds` | INT NULL | |
| `started_at` | DATETIME(3) | gravado ao clicar em **Iniciar** |
| `deadline_at` | DATETIME(3) NULL | `started_at` + limite |
| `finished_at` | DATETIME(3) NULL | |
| `finish_reason` | ENUM('user','time') NULL | |
| `duration_seconds` | INT NULL | |
| `correct_count`, `wrong_count`, `blank_count` | INT NULL | `wrong_count` já inclui as em branco |
| `score` | DECIMAL(4,2) NULL | 0,00 a 10,00 |

Índices: `(user_id, status)` e `(user_id, bank_id)`. Um usuário pode ter várias tentativas do mesmo simulado, inclusive mais de uma em andamento. Descartar uma tentativa apaga a linha e as questões dela.

### `attempt_questions` (uma linha por questão da tentativa)
| Coluna | Tipo | Observação |
|---|---|---|
| `attempt_id` | FK → attempts | PK composta |
| `question_id` | FK → questions | PK composta |
| `number` | INT | número exibido (1..N), fixo |
| `page` | INT | página atual; muda ao reorganizar as em branco |
| `sort` | INT | ordem dentro da prova |
| `option_order` | JSON | ex.: `[2,0,3,1]`, ou seja, a letra A mostra a alternativa original 2 |
| `selected_option` | TINYINT NULL | índice **original** (0–3), comparado direto com o gabarito |
| `is_correct` | BOOLEAN NULL | preenchido ao finalizar |
| `answered_at` | DATETIME(3) NULL | |

Índice: `(attempt_id, page, sort)`.

### `sessions`
Tabela criada pelo `express-mysql-session`. A sessão guarda só `userId`, `role` e `sessionVersion`.

---

## 8. Criptografia

### 8.1 Chaves
- O `.env` guarda **uma chave mestra**, `ENCRYPTION_KEY`, com 32 bytes aleatórios em base64.
- Na inicialização, o app deriva 3 subchaves com **HKDF-SHA256**, usando um `info` diferente para cada uma:
  - `k_db`, para os campos do banco;
  - `k_files`, para os arquivos do volume;
  - `k_index`, para o índice de busca do e-mail.
- Para gerar as chaves: `npm run keys:generate`.
- O app **não sobe** se a chave faltar ou não tiver 32 bytes.

### 8.2 Formato do dado criptografado
- Algoritmo **AES-256-GCM**, com IV aleatório de 12 bytes **a cada operação**.
- Layout: `versão da chave (1 byte) | IV (12) | tag (16) | dados`. No banco fica em base64; no arquivo, em binário.
- **AAD** (dado associado): `tabela.coluna:id` (ex.: `users.email:0192…`). Isso impede copiar o valor criptografado de uma linha para outra. Nos arquivos, o AAD é o `storage_key`.
- O GCM detecta adulteração: um dado alterado gera erro ao decifrar, em vez de devolver lixo.
- O byte de versão deixa a rotação de chave preparada para depois.

### 8.3 O que é criptografado

| Dado | Tratamento |
|---|---|
| Senha | **Argon2id** (hash irreversível, nem o admin consegue ver) |
| E-mail (login) | AES-256-GCM + índice de busca (garante e-mail único e serve ao login e ao "Esqueci minha senha") |
| Nome completo, telefone | AES-256-GCM |
| Nome do grupo | AES-256-GCM |
| Arquivo `.md` | AES-256-GCM, nome aleatório no disco |
| Título e nome original do arquivo | AES-256-GCM |
| Questões (enunciado, alternativas, gabarito) | AES-256-GCM |
| Respostas, ordem, contadores, nota, datas, flags | **texto claro** (decisão sua: sem a chave, não dá para saber de quem são) |

### 8.4 Busca por dado criptografado
Como cada operação usa um IV aleatório, o mesmo e-mail gera um texto criptografado diferente a cada vez, e por isso não dá para fazer `WHERE email = ?`. A solução é um **índice de busca** (*blind index*): `HMAC-SHA256(k_index, "email:" + e-mail normalizado)`, guardado numa coluna UNIQUE.

No login e no "Esqueci minha senha", o servidor calcula o HMAC do que foi digitado e busca por ele. A normalização é `trim` + minúsculas + Unicode NFC.

### 8.5 Senhas
- Argon2id com parâmetros no mínimo iguais aos do OWASP (m = 19 MiB, t = 2, p = 1).
- Senha com no mínimo 10 caracteres. A do admin do seed precisa ter 12.
- As senhas temporárias são geradas com `crypto.randomInt`, exibidas uma única vez e nunca gravadas em texto.

### 8.6 Cuidados
- ⚠️ **Perder a `ENCRYPTION_KEY` significa perder todos os dados.** Guarde uma cópia fora do servidor, num gerenciador de senhas. Um backup do banco sem a chave é inútil, e guardar a chave junto do backup anula a proteção.
- Nunca logar dado decifrado, senha ou chave.
- A criptografia nativa do MySQL (InnoDB) é opcional e só complementa; não substitui a criptografia na aplicação.

---

## 9. Checklist de segurança

- [ ] Segredos ficam só no `.env` (ou nas variáveis do Coolify). `.env` está no `.gitignore`, e o `.env.example` não tem valores reais.
- [ ] O `.env` é validado com zod na subida, e o app não sobe se faltar alguma variável.
- [ ] HTTPS fica a cargo do proxy do Coolify, com `app.set('trust proxy', 1)`.
- [ ] Cookie de sessão `httpOnly`, `Secure`, `SameSite=Lax` e com nome próprio. A sessão é regenerada no login e expira após 8 h **sem uso**, renovando a cada requisição.
- [ ] A cada requisição, o app confere `active`, `must_change_password` e `session_version`. Redefinir senha, trocar senha ou desativar o usuário derruba as sessões dele.
- [ ] Token CSRF em todo `POST` de formulário e no cabeçalho dos `fetch`.
- [ ] Login com mensagem genérica, limite de tentativas por IP e bloqueio de 15 min após 5 falhas. O Argon2 roda mesmo quando o e-mail não existe, para o tempo de resposta não revelar quem está cadastrado.
- [ ] "Esqueci minha senha" sempre dá a mesma resposta e tem limite por IP.
- [ ] Middleware por perfil. Toda consulta de simulado passa por uma única função de permissão (dono, membro de um grupo compartilhado ou quem já fez; a regra está na [seção 7](#7-modelo-de-dados)). Ações de dono checam o dono. Recurso alheio e rota de outro perfil respondem 404.
- [ ] Ao importar ou mudar o compartilhamento, o servidor confere se o usuário é membro de todos os grupos escolhidos.
- [ ] XSS: Markdown sem HTML cru + `rehype-sanitize` na importação; EJS sempre com escape (`<%= %>`). Só o HTML de questão já sanitizado usa `<%- %>`.
- [ ] CSP via helmet: `default-src 'self'`, nenhum script inline (todo o JS em arquivos) e `img-src 'self' data:`.
- [ ] Upload: até 1 MB, só `.md`, só UTF-8 e nunca usar o nome original no disco. O volume fica fora da pasta pública.
- [ ] O gabarito **nunca** vai para o navegador durante a prova. A correção e o tempo limite são validados no servidor.
- [ ] O usuário MySQL da aplicação não é root e só tem acesso ao banco do app.
- [ ] O container roda como usuário não-root.
- [ ] `npm audit` antes de cada deploy e versões exatas no `package.json`.

---

## 10. Variáveis de ambiente (`.env.example`)

A lista completa, com comentários, está em [.env.example](.env.example). As variáveis são validadas na subida por [src/config/env.ts](src/config/env.ts), e o app não sobe se faltar alguma obrigatória.

| Grupo | Variáveis |
|---|---|
| Aplicação | `NODE_ENV`, `PORT`, `TRUST_PROXY` |
| Banco | `DATABASE_URL` |
| Sessão | `SESSION_SECRET`, `SESSION_IDLE_HOURS`, `COOKIE_SECURE` (opcional; só para testar a imagem sem HTTPS) |
| Criptografia | `ENCRYPTION_KEY`, `ENCRYPTION_KEY_VERSION` |
| Arquivos | `STORAGE_PATH`, `MAX_UPLOAD_MB` |
| Admin (seed) | `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` |
| Login | `LOGIN_MAX_FAILS`, `LOGIN_LOCK_MINUTES`, `FORGOT_MAX_PER_HOUR` |
| Só desenvolvimento | `MYSQL_*` (docker-compose), `MYSQL_HOST_PORT` (3307, porque a 3306 já está em uso na máquina de desenvolvimento), `TEST_DATABASE_URL` |

---

## 11. Estrutura de pastas

```
simulados/
├─ src/
│  ├─ server.ts                 # sobe o servidor
│  ├─ app.ts                    # Express + middlewares + páginas de erro
│  ├─ config/env.ts             # leitura e validação do .env (zod)
│  ├─ http/                     # sessão, CSRF, perfis, mensagens
│  ├─ db/
│  │  ├─ schema.ts              # tabelas (Drizzle)
│  │  ├─ client.ts
│  │  └─ migrations/
│  ├─ crypto/
│  │  ├─ keys.ts                # derivação HKDF
│  │  ├─ cipher.ts              # encrypt/decrypt com AAD
│  │  ├─ blind-index.ts         # índice de busca do e-mail
│  │  └─ file-store.ts          # leitura/gravação criptografada no volume
│  ├─ markdown/
│  │  ├─ parse-questions.ts     # .md → questões + erros + avisos
│  │  ├─ render.ts              # Markdown → HTML sanitizado
│  │  └─ gpt-fix-message.ts     # monta a mensagem de correção para o ChatGPT
│  ├─ modules/
│  │  ├─ auth/                  # login, esqueci senha, alterar senha, middlewares
│  │  ├─ admin-users/
│  │  ├─ admin-groups/          # grupos e membros
│  │  ├─ banks/                 # importação, compartilhamento, permissões (dono, membro ou quem já fez)
│  │  └─ attempts/              # iniciar, prova, reorganizar, tempo limite, correção, relatório
│  ├─ views/                    # EJS (inclui errors/404.ejs e errors/500.ejs)
│  └─ public/                   # css/ e js/prova.js (cronômetro, mapa, salvamento automático)
├─ modelos/
│  ├─ modelo-questoes.md        # ✅ já criado
│  └─ prompt-chatgpt.txt        # ✅ já criado
├─ scripts/
│  ├─ migrate.ts
│  ├─ seed-admin.ts             # idempotente
│  ├─ admin-reset-password.ts   # senha temporária para o admin via terminal
│  └─ generate-keys.ts
├─ tests/
├─ Dockerfile
├─ docker-compose.yml           # MySQL para desenvolvimento local
├─ .env.example
└─ package.json
```

---

## 12. Deploy no Coolify

1. **Banco**: criar um recurso **MySQL 8** no Coolify, no mesmo projeto e servidor. Criar o database e o usuário da aplicação e usar a URL interna em `DATABASE_URL`. Ligar os **backups agendados** do Coolify, de preferência enviando para um S3.
2. **Aplicação**: criar um recurso a partir do repositório Git, com build pack **Dockerfile**.
3. **Variáveis**: colar o conteúdo do `.env` em *Environment Variables* (o modo de edição em lote aceita o arquivo inteiro). Nenhuma deve ser marcada como *Build Variable*, porque segredo não pode ir para dentro da imagem.
4. **Persistent Storage**: montar um volume em `/app/storage`.
5. **Domínio + HTTPS**: o proxy do Coolify cuida disso, com Let's Encrypt.
6. **Healthcheck**: apontar para `GET /health`. O healthcheck do Coolify depende do `curl`, que precisa ser instalado na imagem final.
7. **Na subida**, o container roda migrations e depois o seed do admin. Os dois são idempotentes: o seed só cria o admin se ele ainda não existir, já com troca de senha obrigatória.
8. **Backups**: banco (Coolify), volume `/app/storage` e a `ENCRYPTION_KEY`, esta guardada **separada** dos outros dois.

O [Dockerfile](Dockerfile) está na raiz do projeto. Ele usa `node:24-bookworm-slim` em vez de `alpine` para evitar problema com o binário nativo do `argon2`, que no Alpine usa musl, e já define o `HEALTHCHECK`.

---

## 13. Desenvolvimento local

O passo a passo está no [README.md](README.md). Em resumo: preencher o `.env`, subir o MySQL com `docker compose up -d mysql`, rodar `npm run db:migrate`, `npm run seed:admin` e `npm run dev`, e abrir `http://localhost:3000`.

Em desenvolvimento (`NODE_ENV=development`), o cookie não exige HTTPS. Para testar a imagem de produção localmente: `docker compose --profile app up --build`.

---

## 14. Fases de implementação

As fases são entregues em 4 blocos. Cada bloco termina com algo que dá para testar no navegador antes do próximo começar. O deploy no Coolify foi antecipado para a entrega 1, para os problemas de infraestrutura aparecerem com o sistema ainda pequeno.

| Entrega | Fases | Situação |
|---|---|---|
| 1. Fundação + deploy | 0, 1 e 2, e publicar no Coolify | código pronto e testado localmente, inclusive a imagem Docker; falta publicar |
| 2. Admin + importação | 3 e 4 | — |
| 3. Prova + relatório | 5 e 6 | — |
| 4. Revisão final | 7 | — |

| Fase | Entrega | Pronto quando |
|---|---|---|
| **0. Base** | Node + TS + Express + EJS, lint, vitest, docker-compose com MySQL, validação do `.env`, `/health`, páginas 404 e 500 | `npm run dev` sobe; `/health` responde 200; rota inexistente mostra a 404 personalizada |
| **1. Criptografia e banco** | módulo de criptografia (HKDF, AES-GCM com AAD, índice de busca), gravação criptografada no volume, schema e 1ª migration | testes cobrem ida e volta, adulteração, AAD errado e arquivo ilegível no disco |
| **2. Autenticação e senhas** | seed do admin, login por e-mail, sessão no MySQL, limite e bloqueio, CSRF, troca obrigatória, alterar senha, esqueci minha senha, `admin:reset-password` | o admin é obrigado a trocar a senha no 1º login; nenhuma rota abre antes da troca; "Esqueci minha senha" responde igual para e-mail cadastrado e não cadastrado |
| **3. Admin: usuários e grupos** | lista com pedidos no topo, criar (nome, e-mail, telefone), editar, desativar, redefinir senha com "Gerar"; criar, renomear e excluir grupos; adicionar e remover membros | o pedido aparece no topo; a redefinição derruba a sessão aberta do usuário e exige troca no próximo login; no banco, nome, e-mail, telefone e nome do grupo estão criptografados |
| **4. Importação e compartilhamento** | parser + validação + avisos, HTML sanitizado, mensagem para o ChatGPT, download do modelo e do prompt, compartilhamento com um ou mais grupos, mudar compartilhamento, exclusão, efeitos de remover membro e excluir grupo, painel com Meus simulados e seções por grupo | o modelo importa sem erro; um arquivo com erro lista tudo e gera a mensagem copiável; um `<script>` no `.md` não executa; simulado privado não aparece para mais ninguém; simulado compartilhado com dois grupos aparece para os membros dos dois, com "Enviado por"; quem não é membro recebe 404; só o dono exclui ou muda o compartilhamento |
| **5. Prova** | suas tentativas, opções (quantidade sorteada e tempo limite), várias tentativas por simulado, descartar, embaralhamento, 10 por página, mapa de questões, cronômetro, salvamento automático, navegação livre, regra de quem já fez fica com o simulado | recarregar mantém respostas e tempo; o HTML não contém o gabarito; 25 questões geram 3 páginas; duas tentativas do mesmo simulado têm ordens e resultados independentes; quando o compartilhamento acaba, quem já fez continua com o simulado como "Recebido de" |
| **6. Finalização e relatório** | confirmação de em branco, reorganização, tempo esgotado, correção no servidor, relatório e histórico | o exemplo de 25 questões com 7 em branco gera páginas 10/8/7; o tempo esgotado finaliza mesmo com o navegador fechado; a nota confere (7 de 10 dá 7,0) |
| **7. Endurecimento e deploy** | helmet/CSP, revisão da [seção 9](#9-checklist-de-segurança), Dockerfile, Coolify, backups, README | app no ar com HTTPS; volume e banco sobrevivem a um redeploy; restauração de backup testada |

---

## 15. Testes

**Unitários**
- **Parser**:
  - aceita o modelo inteiro;
  - acusa 3 ou 5 alternativas, 0 ou 2 corretas, enunciado vazio e "todas as anteriores";
  - não confunde `- [x]` dentro de bloco de código com alternativa;
  - lida com lista comum colada nas alternativas;
  - aceita CRLF e BOM e remove HTML cru;
  - gera aviso para texto depois das alternativas.
- **Mensagem para o ChatGPT**: cita o número da questão e o começo do enunciado e inclui as regras do formato.
- **Criptografia**: ida e volta, IV diferente a cada chamada, adulteração detectada, AAD trocado falhando, chave com tamanho errado e índice do e-mail igual para "Fulano@X.com " e "fulano@x.com".
- **Embaralhamento**: a correção segue certa com qualquer `option_order`, e o relatório mostra a letra que o usuário viu.
- **Reorganização**: com 25 questões e 7 em branco, as páginas ficam 10/8/7. Com 12 respondidas e 13 em branco, ficam 10/2/10/3. Os números das questões não mudam.
- **Nota**: 0/10, 10/10, arredondamento de 7/9 e questões em branco contando como erradas.

**Integração** (supertest + MySQL de teste)
- Login certo, errado e bloqueado; troca obrigatória; esqueci minha senha seguido de redefinição e de novo login com troca.
- Separação admin × usuário; IDOR (usuário A tentando abrir a tentativa de B).
- Compartilhamento:
  - privado invisível para os outros; compartilhado com dois grupos visível para os membros dos dois e 404 para quem não é membro;
  - importar para um grupo do qual o usuário não participa é recusado;
  - só o dono muda o compartilhamento ou exclui;
  - para cada situação da tabela da [seção 5.7](#57-compartilhamento-em-grupos): quem nunca fez perde o acesso, quem já fez passa a ver o simulado como "Recebido de" e pode refazê-lo, e os relatórios de todos continuam;
  - dono removido de um grupo: os simulados dele saem só desse grupo;
  - grupo excluído: o simulado que fica sem nenhum grupo volta a ser privado do dono.
- Tentativas: duas tentativas do mesmo simulado são independentes; descartar apaga só a tentativa escolhida.
- Tempo limite: resposta depois do prazo é recusada; acesso depois do prazo finaliza.
- Fluxo completo: importar → iniciar → responder → finalizar com em branco → "Não" → responder → finalizar → relatório.

---

## 16. Registro de decisões

| Tema | Decisão |
|---|---|
| Stack | Node + Express + EJS |
| Formato do `.md` | modelo e prompt criados pelo sistema; as questões vêm do ChatGPT |
| Quem importa | cada usuário; na importação escolhe entre privado e um ou mais dos seus grupos |
| Papel do admin | cria usuários e grupos e define os membros; não importa nem vê simulados ou resultados |
| Grupos | só compartilham questões; cada tentativa é individual |
| Compartilhamento | só o dono muda ou exclui |
| Quem já fez um simulado compartilhado | fica com ele, como privado, quando o compartilhamento acaba |
| Dono removido de um grupo | os simulados dele saem desse grupo |
| Grupo excluído | os simulados saem do grupo; sem nenhum grupo, voltam a ser privados do dono |
| Painel | os próprios simulados aparecem só em Meus simulados |
| "Já fez" | ter iniciado pelo menos uma tentativa (tentativa descartada não conta) |
| Simulado recebido | pode refazer; não pode compartilhar nem excluir |
| Dono exclui o simulado | some para o dono e para quem nunca fez; quem já fez continua com ele |
| Simulado em dois grupos da pessoa | aparece na seção de cada grupo |
| Login | e-mail + senha |
| Cadastro de usuário | nome completo, telefone e e-mail |
| Opções do simulado | cada usuário escolhe ao iniciar (quantidade e tempo limite) |
| Repetir simulado | quantas vezes quiser |
| Tentativas em andamento | podem ser descartadas; pode haver mais de uma ao mesmo tempo |
| Validação | tudo ou nada, com mensagem pronta para o ChatGPT corrigir |
| Em branco ao finalizar | confirmação; "Não" leva as em branco para o final, em páginas próprias |
| Em branco na nota | conta como errada |
| Navegação | pode voltar às páginas anteriores |
| Página 404 | personalizada (e uma página 500 genérica) |
| Resultados no banco | texto claro (o resto está criptografado) |
| Esqueci minha senha | pedido aparece no topo da lista do admin; o admin redefine e envia por fora; troca obrigatória no 1º login, inclusive do admin e de usuário recém-criado |
| Admin esqueceu a senha | comando `npm run admin:reset-password` no terminal |
| Gestão de usuários | criar, editar, desativar e redefinir senha; sem exclusão |
| Explicação por questão | não |
| Embaralhar questões e alternativas | sim, sempre |
| Mapa de questões | sim |
| Refazer só as erradas | não |
| Tempo limite com finalização automática | sim, opcional |
| Sortear N questões | sim, opcional |
| Gráfico de evolução | não |
| Imagens | não, por enquanto |