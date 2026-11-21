# IA local do CRM (WhatsApp) e ligações (LiveKit)

O CRM tem duas frentes de IA:

| Frente | Onde roda | Para que serve |
| --- | --- | --- |
| llama.cpp (`127.0.0.1:8080`) | seu notebook | escrever as respostas no WhatsApp |
| whisper.cpp (`127.0.0.1:8081`) | seu notebook | transcrever áudios que o cliente manda no chat |
| LiveKit Cloud | nuvem | ligações pelo navegador (voz da IA e conversa com o lead) |

A voz local (Piper / voz do Windows) **foi removida**. Não existe mais painel de
"IA por voz" no CRM: o atendimento por áudio acontece nas **ligações LiveKit**.
Passo a passo das ligações: [LIGACOES_LIVEKIT.md](LIGACOES_LIVEKIT.md).

## 1. Instalar e subir

Na raiz do projeto:

1. `INSTALAR_IA_VOZ.bat` — baixa llama.cpp, whisper.cpp, Qwen 1.5B e Whisper small
   para `tools\ai`. É idempotente: pode rodar de novo.
2. `INICIAR_IA_VOZ.bat` — sobe os dois motores em segundo plano, só em
   `127.0.0.1`, e espera eles responderem. Se já estiverem no ar, não duplica.
3. `run-crm.bat` — sobe o CRM em `http://localhost:3001`.

Logs e PIDs ficam em `tools\ai\logs` e `tools\ai\run`. Para parar:
`PARAR_IA_VOZ.bat`. Para conferir tudo: `scripts\ai\test-ai.ps1`.

## 2. Como usar no CRM

Abra um lead e vá na aba **IA no WhatsApp**.

- **Atendimento automático**: liga a resposta automática só para aquele lead.
  A IA responde **quando o cliente escreve** — nunca dispara sozinha ao abrir a
  conversa. O botão **IA iniciar conversa** é a exceção explícita: gera e envia a
  primeira mensagem, apenas em conversa nova (sem nenhuma mensagem).
- **Histórico**: cada atendimento automático fica em `lead_ai_sessions` /
  `lead_ai_messages` (migration 016 + coluna `channel` da 017). Sem as migrations,
  o histórico fica em memória e a tela avisa.
- **Ligações**: o cartão "Ligar para o lead" cria a sala no LiveKit e o link para
  o cliente abrir no navegador. Veja `LIGACOES_LIVEKIT.md`.

Mensagens que você manda pelo próprio app do WhatsApp entram no CRM como saída,
mas **não** acionam a IA (`fromMe` nunca dispara resposta automática).

## 3. Configuração (`.env`)

Todas as variáveis são opcionais; os padrões funcionam no notebook descrito.

```ini
AI_ENABLED=true
AI_HOME=./tools/ai
AI_ASSISTANT_NAME=Sofia
AI_COMPANY_NAME=

LLAMA_BASE_URL=http://127.0.0.1:8080
LLAMA_MODEL=qwen2.5-1.5b-instruct
LLAMA_TIMEOUT_MS=120000
AI_CONTEXT_TOKENS=2048
AI_MAX_OUTPUT_TOKENS=220
AI_TEMPERATURE=0.6

WHISPER_BASE_URL=http://127.0.0.1:8081
WHISPER_LANGUAGE=pt
AI_AUDIO_MAX_BYTES=12582912
AI_AUDIO_MAX_SECONDS=60

AI_STORAGE=auto          # auto | db | memory
AI_WHATSAPP_DELAY_MS=2500
AI_WHATSAPP_MAX_REPLIES=8
```

As variáveis do LiveKit estão em `LIGACOES_LIVEKIT.md`.

## 4. Endpoints (`/api/ai`)

| Método | Rota | Função |
| --- | --- | --- |
| GET | `/status?refresh=1` | llama, whisper, histórico e LiveKit |
| GET | `/sessions?leadId=` | histórico já gravado |
| GET | `/sessions/:id` | sessão + mensagens |
| POST | `/calls/:leadId` | cria sala + link (e envia no WhatsApp, opcional) |
| GET | `/calls/:leadId` | ligações do lead |
| POST | `/calls/:leadId/:callId/share` | reenvia o link no WhatsApp |
| POST | `/calls/:leadId/:callId/end` | encerra a sala e grava a duração |
| GET/PUT | `/whatsapp-auto/:leadId` | estado da resposta automática |
| POST | `/whatsapp-auto/:leadId/start` | IA gera e envia a abordagem inicial |

## 5. Banco de dados

- `016_ai_voice_sessions.sql`: `lead_ai_sessions` e `lead_ai_messages`.
- `017_ai_whatsapp_auto.sql`: `lead_ai_whatsapp_auto` + coluna `channel`.

As ligações reaproveitam `lead_ai_sessions` com `channel = 'ligacao'`, então não
há migration nova para elas.

## 6. Privacidade e segurança

- llama.cpp e whisper.cpp escutam **somente** em `127.0.0.1`; nada dos leads vai
  para a internet no fluxo do WhatsApp.
- Nenhuma chave de IA aparece no navegador. O front só recebe texto, booleanos e
  links de ligação assinados.
- As ligações passam pelo LiveKit Cloud (WebRTC criptografado). O link do lead
  vence no prazo configurado e pode ser encerrado antes na tela.

## 7. Problemas comuns

| Sintoma | O que conferir |
| --- | --- |
| "IA indisponível" | `INICIAR_IA_VOZ.bat`; depois `scripts\ai\test-ai.ps1` e `tools\ai\logs\llama.err.log`. |
| IA não respondeu no WhatsApp | `backend\data\ia-whatsapp.log` e `whatsapp-incoming.log`; veja se a opção está ligada no lead e se o WhatsApp está conectado. |
| Áudio do cliente sem texto | whisper fora do ar (`/health` em 8081) ou ffmpeg ausente. |
| Resposta muito lenta | normal em CPU: o Qwen 1.5B leva de 10 a 60 s. Reduza `AI_MAX_OUTPUT_TOKENS`. |
| Histórico "em memória" | migration 016/017 não aplicada no Supabase. |

## 8. Arquivos desta implementação

Backend:

- `backend/services/ai/aiConfig.js` — configuração
- `backend/services/ai/llamaCppService.js` — conversa
- `backend/services/ai/whisperService.js` — transcrição
- `backend/services/ai/leadContextService.js` — contexto do lead
- `backend/services/ai/aiSessionsStore.js` — histórico
- `backend/services/ai/whatsappAutoReply.js` — resposta automática
- `backend/services/livekit/livekitService.js` — salas e tokens LiveKit
- `backend/routes/aiRoutes.js` — rotas `/api/ai`
- `backend/scripts/test-ai-whatsapp-auto.js` — teste (46 verificações)

Agente e página:

- `agents/livekit/` — agente de voz na nuvem (opcional)
- `frontend/ligacao.html` — página pública da ligação

Scripts e atalhos:

- `scripts/ai/install-ai.ps1`, `start-ai.ps1`, `stop-ai.ps1`, `test-ai.ps1`
- `INSTALAR_IA_VOZ.bat`, `INICIAR_IA_VOZ.bat`, `PARAR_IA_VOZ.bat`
