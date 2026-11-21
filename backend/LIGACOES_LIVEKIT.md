# Ligações para leads pelo navegador (LiveKit Cloud)

O CRM liga para o lead por uma chamada WebRTC: o lead recebe um **link** e entra
pela página `frontend/ligacao.html`, sem instalar aplicativo. O atendente entra
pela mesma sala; se o agente de IA estiver publicado, ele também entra e atende.

Telefone comum (PSTN) **não** é discado. O plano gratuito do LiveKit cobre as
ligações pelo navegador e os minutos de agente; para tocar em um celular fixo
seria preciso contratar um trunk SIP/telefonia à parte.

## 1. Criar o projeto no LiveKit Cloud

1. Acesse [cloud.livekit.io](https://cloud.livekit.io) e crie um projeto gratuito.
2. Em **Settings ? Keys**, copie a **URL** (`wss://...livekit.cloud`), a **API Key**
   e o **API Secret**.

O plano gratuito ("Build") inclui, por mês, **1.000 minutos de agente**,
**5.000 minutos de WebRTC**, 5 chamadas simultâneas e 1 número norte-americano
para chamadas recebidas (não serve para ligar a números brasileiros). Confira os
números atuais em [livekit.com/pricing](https://livekit.com/pricing).

## 2. Configurar o backend

Em `backend/.env` (as mesmas linhas podem ficar na raiz `.env`):

```ini
LIVEKIT_URL=wss://seu-projeto.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
# Nome do agente publicado em agents/livekit (vazio = só navegador <-> navegador)
LIVEKIT_AGENT_NAME=
# Endereço público do CRM usado no link enviado ao lead
PUBLIC_BASE_URL=
# Validade do link da ligação em minutos (padrão 240)
LIVEKIT_TOKEN_TTL_MIN=240
```

Reinicie o backend. No cartão **Ligar para o lead** o selo deve mostrar
"LiveKit pronto".

### O link precisa ser público

O celular do lead não abre `http://localhost:3001`. Duas opções:

- **Produção**: use o domínio do Railway em `PUBLIC_BASE_URL`
  (ex.: `https://crm-comercial-production.up.railway.app`).
- **Local**: abra o CRM pelo túnel do `ABRIR_PARA_A_EQUIPE.bat`/ngrok e use o
  endereço `https://....ngrok-free.app` em `PUBLIC_BASE_URL`.

Se `PUBLIC_BASE_URL` estiver vazio, o backend usa o host da própria requisição —
funciona no Railway, mas no localhost gera um aviso na tela.

## 3. Como ligar

1. Abra o lead ? aba **IA no WhatsApp** ? cartão **Ligar para o lead**.
2. **Gerar link de ligação**: cria a sala e mostra o link do lead.
3. **Abrir minha ligação**: abre a página da chamada no navegador do atendente.
4. **Copiar link** ou **Gerar e enviar no WhatsApp**: entrega o link ao cliente.
5. **Encerrar sala** quando terminar. A duração fica no histórico de ligações do
   lead (tabela `lead_ai_sessions`, canal `ligacao`).

O atendente precisa permitir o microfone no navegador. O lead também. A voz da
IA (quando o agente está configurado) é gerada na nuvem.

## 4. Agente de IA (opcional)

Sem agente, a ligação é entre você e o lead. Com o agente, a Sofia entra na sala e
conversa com o lead usando o contexto do CRM (empresa, etapa do funil, últimas
interações).

O agente fica em `agents/livekit/` e usa o **LiveKit Inference**: STT, LLM e TTS
rodam na nuvem com as credenciais do próprio projeto, sem chave da OpenAI,
Deepgram ou Cartesia.

### Rodar localmente

```bash
cd agents/livekit
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

set LIVEKIT_URL=wss://seu-projeto.livekit.cloud
set LIVEKIT_API_KEY=...
set LIVEKIT_API_SECRET=...
set LIVEKIT_AGENT_NAME=sofia-crm

python agent.py dev
```

### Publicar no LiveKit Cloud

Com a [LiveKit CLI](https://docs.livekit.io/home/cli/) instalada:

```bash
lk agent create
```

O nome publicado precisa ser o mesmo de `LIVEKIT_AGENT_NAME` no backend. Com
isso, cada nova ligação aciona o agente automaticamente (o backend chama a API
de dispatch e envia o contexto do lead no metadata do job).

Modelos podem ser trocados sem mexer no código:

```ini
LK_STT_MODEL=deepgram/nova-3
LK_LLM_MODEL=google/gemma-4-31b-it
LK_TTS_MODEL=gradium/default
LK_TTS_VOICE=Bianca
LK_LANGUAGE=pt-BR
```

A lista de modelos e vozes está em
[docs.livekit.io/agents/models](https://docs.livekit.io/agents/models/).

## 5. Como funciona por dentro

1. `POST /api/ai/calls/:leadId` cria uma sessão `channel = 'ligacao'`, monta o
   contexto do lead e cria a sala `call_<id>` no LiveKit.
2. O backend assina dois tokens HS256 (atendente e lead) com a API Secret. O
   token contém a sala, o nome e o papel; nada de chave vai ao navegador.
3. A página `ligacao.html` lê o token da URL, conecta no `wss://` informado e
   publica o microfone.
4. Se `LIVEKIT_AGENT_NAME` estiver configurado, o backend aciona o agente com o
   metadata `{ kind: 'crm-call', leadId, leadName, company, context... }`.
5. `POST .../end` apaga a sala e grava a duração.

Endpoints:

| Método | Rota | Função |
| --- | --- | --- |
| POST | `/api/ai/calls/:leadId` | cria sala e link (`sendWhatsApp` opcional) |
| GET | `/api/ai/calls/:leadId` | histórico de ligações |
| POST | `/api/ai/calls/:leadId/:callId/share` | reenvia o link no WhatsApp |
| POST | `/api/ai/calls/:leadId/:callId/end` | encerra e grava a duração |

## 6. Problemas comuns

| Sintoma | Causa provável |
| --- | --- |
| "LiveKit não configurado" | faltam `LIVEKIT_URL`, `LIVEKIT_API_KEY` ou `LIVEKIT_API_SECRET`; reinicie o backend. |
| Link abre em branco ou 404 | backend antigo em produção: publique a versão com `frontend/ligacao.html`. |
| Lead não consegue abrir | link aponta para localhost: configure `PUBLIC_BASE_URL`. |
| "Link expirado" | passou de `LIVEKIT_TOKEN_TTL_MIN`; gere um novo link. |
| Sem áudio | microfone bloqueado no navegador (ícone de cadeado). |
| Agente não entra | `LIVEKIT_AGENT_NAME` diferente do nome publicado, ou agente offline. |
| Sala não encerra | backend reiniciado perde o registro em memória; a sala expira sozinha e o link vence no prazo. |
