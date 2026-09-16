# Hospedagem Completa na Vercel (Frontend + Backend 100% no Vercel)

Seu CRM agora está configurado para rodar **integralmente na Vercel**:
- **Frontend (Interface Web):** Servido globalmente via CDN da Vercel
- **Backend (API Node.js + Express + Supabase):** Roda como Serverless Functions na própria Vercel (`/api/...`)
- **Tudo em um único link, sem necessidade de Render e sem problemas de CORS!**

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
