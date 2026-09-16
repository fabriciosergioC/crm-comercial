# Guia Passo a Passo: Hospedagem do CRM (Vercel + Render)

Este guia explica exatamente como colocar seu CRM no ar gratuitamente:
- **Backend (API Node.js + Supabase):** [Render.com](https://render.com) (Plano Gratuito)
- **Frontend (Interface Web):** [Vercel.com](https://vercel.com) (Plano Gratuito)

---

## Passo 1: Criar um Repositório no GitHub

Para que a Vercel e o Render possam hospedar seu código, você precisa subir seu projeto para o GitHub:

1. Acesse [github.com](https://github.com) e faça login.
2. Clique no botão **"+"** (canto superior direito) e selecione **"New repository"**.
3. Dê um nome ao repositório (ex.: `crm-comercial`).
4. Deixe como **Public** ou **Private** (ambos funcionam gratuitamente na Vercel e no Render).
5. **Não marque** as opções de adicionar README ou .gitignore (já criamos tudo).
6. Clique em **"Create repository"**.
7. No seu terminal (PowerShell), na pasta do projeto, execute os comandos abaixo substituindo pelo seu link do GitHub:

```powershell
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/crm-comercial.git
git push -u origin main
```

*(O arquivo `backend/.env` já está protegido pelo `.gitignore` e não será enviado para o GitHub por segurança).*

---

## Passo 2: Hospedar o Backend no Render (API)

1. Acesse [render.com](https://render.com) e crie uma conta gratuita (você pode entrar com o seu GitHub).
2. No painel (Dashboard), clique em **"New +"** e selecione **"Web Service"**.
3. Selecione a opção **"Build and deploy from a Git repository"** e clique em **Next**.
4. Conecte sua conta do GitHub e selecione o repositório que acabou de criar (`crm-comercial`).
5. Preencha as configurações do serviço:
   - **Name:** `crm-backend` (ou o nome que preferir)
   - **Region:** Escolha uma região próxima (ex.: *Ohio* ou *Frankfurt*)
   - **Branch:** `main`
   - **Root Directory:** `backend`  ⚠️ *(Importante: digite `backend` aqui!)*
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
6. Role até a seção **"Environment Variables"** (Variáveis de Ambiente) e adicione as 3 variáveis:

| Key | Value |
|---|---|
| `SUPABASE_URL` | `https://ofppvppxdxrkfoixjfrh.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | *(cole sua chave eyJhbGci... do backend/.env)* |
| `CORS_ORIGIN` | `*` |

7. Clique no botão **"Create Web Service"**.
8. O Render iniciará a compilação. Em cerca de 1 a 2 minutos, o status mudará para **"Live"**.
9. No topo da página do Render, copie a URL do seu backend. Ela terá o formato:
   `https://crm-backend-xxxx.onrender.com`

---

## Passo 3: Hospedar o Frontend na Vercel

1. Acesse [vercel.com](https://vercel.com) e crie uma conta gratuita (ou faça login com o GitHub).
2. Clique em **"Add New..."** -> **"Project"**.
3. Selecione o repositório `crm-comercial` e clique em **"Import"**.
4. Nas configurações do projeto:
   - O arquivo `vercel.json` na raiz já configura tudo automaticamente para a pasta `frontend`.
   - Você não precisa alterar nenhuma configuração de Build.
5. Clique no botão **"Deploy"**.
6. Em menos de 30 segundos, seu site estará no ar!
7. Clique em **"Continue to Dashboard"** ou no link gerado (ex.: `https://crm-comercial-xxxx.vercel.app`).

---

## Passo 4: Conectar o Frontend ao Backend em Produção

Você tem duas maneiras muito fáceis de apontar o frontend da Vercel para o seu backend do Render:

### Opção A: Diretamente na tela (Mais fácil e imediato)
1. Abra o link do seu CRM na Vercel (`https://seu-crm.vercel.app`).
2. No topo direito, você verá o badge **Modo Local (Configurar API)**.
3. Clique sobre o badge.
4. Uma janelinha se abrirá pedindo a URL da API. Cole a URL do Render adicionando `/api` no final:
   ```
   https://crm-backend-xxxx.onrender.com/api
   ```
5. Clique em **OK**. A página recarregará e o badge mudará para 🟢 **Supabase Conectado**!
*(Essa configuração fica salva no seu navegador).*

### Opção B: Deixar gravado no código (`frontend/config.js`)
1. No arquivo `frontend/config.js`, preencha a linha com a URL do Render:
   ```javascript
   window.CRM_API_URL = "https://crm-backend-xxxx.onrender.com/api";
   ```
2. Salve, faça commit e push para o GitHub:
   ```powershell
   git add frontend/config.js
   git commit -m "fix: url do backend de producao"
   git push
   ```
3. A Vercel atualizará o deploy automaticamente e qualquer usuário que acessar o site já estará conectado à API!
