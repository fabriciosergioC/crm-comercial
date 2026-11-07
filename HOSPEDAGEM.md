# Hospedagem Completa na Vercel (Frontend + Backend 100% no Vercel)

Seu CRM agora está configurado para rodar **integralmente na Vercel**:
- **Frontend (Interface Web):** Servido globalmente via CDN da Vercel
- **Backend (API Node.js + Express + Supabase):** Roda como Serverless Functions na própria Vercel (`/api/...`)
- **Tudo em um único link, sem necessidade de Render e sem problemas de CORS!**

> **⚠️ Arquitetura atual (recomendada): Vercel + VPS.** O deploy 100% na Vercel
> continua válido para **dados** (funções serverless), mas o **WhatsApp via
> Baileys não roda lá** — precisa de processo persistente e disco durável.
> Produção nova: frontend estático na Vercel + API/Baileys na VPS
> (`https://api.crm-comercial.com/api`).

---

## Passo a Passo para Publicar na Vercel

### 1. Acesse o painel da Vercel
Acesse **[vercel.com](https://vercel.com)** e faça login com a sua conta do GitHub.

### 2. Importar o Repositório
1. No dashboard da Vercel, clique no botão **"Add New..."** -> **"Project"**.
2. Localize o repositório **`fabriciosergioC/crm-comercial`** e clique no botão **"Import"**.

### 3. Configurar as Variáveis de Ambiente (Supabase)
Antes de clicar em Deploy, abra a seção **"Environment Variables"** e adicione as seguintes 2 variáveis:

| Name | Value |
| :--- | :--- |
| `SUPABASE_URL` | `https://ofppvppxdxrkfoixjfrh.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | *(copie a sua chave do arquivo `backend/.env`)* |

*(Opcional: você também pode definir `CORS_ORIGIN=*`, mas como o frontend e a API estão no mesmo domínio na Vercel, as requisições nem passam por CORS).*

### 4. Clicar em "Deploy"
1. Clique no botão azul **"Deploy"**.
2. A Vercel instalará as dependências e publicará o sistema em cerca de **30 a 50 segundos**.
3. Pronto! Você receberá o link oficial (exemplo: `https://crm-comercial.vercel.app`).

---

## Como funciona

- Quando você acessar o link da Vercel, a interface abrirá imediatamente.
- Todas as chamadas para `/api/leads`, `/api/proposals`, etc. serão processadas pelas funções serverless da Vercel conectadas ao seu banco no Supabase.
- Qualquer alteração que você fizer no código no futuro e der `git push`, a Vercel atualizará automaticamente em segundos.

### Verificar a API publicada

Depois do deploy, abra `https://SEU-DOMINIO/api/health`. A resposta precisa
conter `status: "ok"` e `database: "configurado"`. Se houver erro 500, confira
os logs de Functions no painel da Vercel. O projeto instala a API a partir do
`package.json` e `package-lock.json` da raiz; mantenha ali as dependências que
`api/index.js` e o servidor Express carregam.

### Limitação do WhatsApp via Baileys

A API de dados HTTP pode rodar como função serverless, mas a sessão Baileys
precisa de conexão WebSocket persistente e armazenamento durável dos arquivos de
autenticação. A Vercel Functions não oferece essas garantias; portanto, não use
a função serverless da Vercel como host da sessão WhatsApp. Para atendimento
WhatsApp confiável, hospede o backend Baileys em um serviço Node.js persistente
com disco/volume durável e configure o CRM para usar a URL desse backend.
Na Vercel, os endpoints de **dados** continuam disponíveis (rede de segurança),
mas o atendimento WhatsApp usa a VPS: `frontend/config.js` aponta
`window.CRM_API_URL` e `window.CRM_WHATSAPP_API_URL` para
`https://api.crm-comercial.com/api` — **somente fora de `localhost`/`file://`**,
então o desenvolvimento local continua batendo em `http://localhost:3001` com o
`run-crm.bat`. A sessão Baileys fica em `/opt/crm/data/whatsapp-auth` na VPS,
sobrevivendo a reboot e servindo qualquer navegador/aparelho (nada mais de
`localhost` preso ao computador de quem roda o `run-crm.bat`).

---

# Abrir o CRM para a equipe pelo ngrok (sem publicar nada)

Isto é o caminho mais rápido para 1 a 3 pessoas da equipe usarem o CRM enquanto
ele roda no seu notebook. Não publica nada na Vercel nem no GitHub: o túnel é um
atalho temporário da internet até o seu `http://localhost:3001`.

## Como abrir (3 cliques)

1. Abra o **`run-crm.bat`** e deixe a janela dele aberta (é o backend).
2. Dê dois cliques em **`ABRIR_PARA_A_EQUIPE.bat`**.
3. Na janela do ngrok, copie a linha que começa com `Forwarding`, o endereço
   `https://....ngrok-free.app`, e mande para a equipe **junto com a senha do
   CRM**. Nada mais: ninguém precisa instalar nada nem copiar token.

Para fechar o acesso: feche a janela do ngrok (ou desligue o notebook). O
`run-crm.bat` continua rodando normalmente; ele não é afetado.

## O que mudou no sistema para isso ser seguro

Antes, a tela de senha era só enfeite: quem descobrisse o endereço podia chamar
`/api/leads` direto e baixar todos os clientes, sem senha. Agora:

- **`backend/middleware/sessionGate.js`** fecha os endpoints de dados (`leads`,
  `whatsapp`, `enrichment`, `agenda`, `demos`, `proposals`, `clients`...). Da
  internet, sem sessão válida a resposta é 401 com a mensagem
  *"Faça login para ver os dados do CRM"*.
- **`backend/services/sessionTokens.js`** assina a sessão com HMAC-SHA256
  (biblioteca nativa do Node, nada instalado). O token vai no cookie
  `crm_session` **httpOnly** — o navegador envia sozinho, o JavaScript da página
  não lê — e expira em 7 dias (ou `SESSION_TTL_HOURS` no `backend\.env`).
- O segredo de assinatura fica em `backend\data\session-secret.key` (criado
  sozinho na primeira vez, já está no `.gitignore`) ou em `SESSION_SECRET` no
  `backend\.env`. Defina `SESSION_SECRET` lá se quiser poder trocá-lo.
- **`frontend/js/session.js`** manda o token no cabeçalho `x-crm-session` quando
  o cookie não vale (página aberta do disco) e, se o backend responder 401,
  devolve a pessoa para a tela de entrada com o aviso certo — em vez do aviso
  vermelho de "backend não responde", que seria mentira.
- **`/api/auth/status` não devolve mais a senha padrão** para pedidos vindos da
  internet; ela só aparece no seu notebook.
- Seu notebook continua **isento**: pedido com endereço `localhost` /
  `127.0.0.1` passa sem token. Você nunca fica trancado fora do seu próprio CRM,
  mesmo se o token expirar.

## Endereços no plano grátis

- Cada vez que você abrir a janela, o ngrok sorteia um endereço novo. A equipe
  teria que receber o link de novo a cada dia.
- Para um link que nunca muda: no painel do ngrok (Sites → Domains) reserve o
  seu domínio grátis `xxxx.ngrok-free.app`, cole ele em um arquivo chamado
  **`NGROK_URL.txt`** na pasta do CRM (só o endereço, uma linha). O atalho lê
  esse arquivo e usa `--url=` automaticamente. O arquivo fica fora do GitHub.
- No plano grátis o ngrok mostra uma página de aviso na primeira visita de cada
  endereço ("You are about to visit..."). A equipe clica em **Visit Site**. Um
  domínio reservado também elimina essa página em contas com esse recurso ativo.

## Criando o login de cada pessoa da equipe

A tela de entrada lista quem existe na tabela `users` do Supabase. Hoje ela mostra
os nomes já cadastrados; para entrar uma pessoa nova, rode no SQL Editor do
Supabase:

```sql
insert into public.users (id, name, active)
values ('maria', 'Maria', true)
on conflict (id) do update set name = excluded.name, active = true;
```

O id (`maria`) é o que fica gravado como responsável nas fichas; o nome (`Maria`)
é o que aparece na tela. A pessoa entra com a **senha inicial** que você passar
para ela e o CRM obriga a criar a senha própria dela no primeiro acesso
(campo `must_change_password` já existe no banco). Para desativar alguém, use
`update public.users set active = false where id = 'maria';` — a pessoa some da
lista e para de conseguir entrar, sem apagar nada.

## Limites que você precisa saber

- O túnel morre quando a janela fecha, o notebook dorme ou fica sem internet.
- O WhatsApp (Baileys) depende do mesmo processo: a equipe só conversa pelo
  WhatsApp enquanto o seu `run-crm.bat` estiver aberto na sua máquina.
- Uma sessão ativa vale para todos os dados — não existe "a Maria só vê os leads
  dela". Se um dia for preciso separar por responsável, isso é trabalho novo.
- Para acesso 24 horas sem depender do notebook, o próximo passo é a VPS do
  `HOSPEDAGEM` acima (`https://api.crm-comercial.com/api`), que já mantém o
  Baileys ligado.

