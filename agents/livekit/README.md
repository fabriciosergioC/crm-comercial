# Agente de voz do CRM (LiveKit Cloud)

Agente opcional que entra nas ligações criadas pelo CRM e conversa com o lead.

- Fala pelo **LiveKit Inference** (STT + LLM + TTS na nuvem, credenciais do
  próprio projeto — sem chave extra).
- Recebe o contexto do lead no metadata do job, montado pelo backend.
- Usa `LIVEKIT_AGENT_NAME` (padrão `sofia-crm`) como nome de registro.

## Rodar local

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt

set LIVEKIT_URL=wss://seu-projeto.livekit.cloud
set LIVEKIT_API_KEY=...
set LIVEKIT_API_SECRET=...
set LIVEKIT_AGENT_NAME=sofia-crm

python agent.py dev
```

## Publicar no LiveKit Cloud

```bash
lk agent create
```

O nome publicado precisa ser idêntico ao `LIVEKIT_AGENT_NAME` do backend, senão
a chamada não é direcionada ao agente.

## Variáveis

| Variável | Padrão | Observação |
| --- | --- | --- |
| `LIVEKIT_AGENT_NAME` | `sofia-crm` | mesmo nome no backend |
| `LK_STT_MODEL` | `deepgram/nova-3` | suporta português |
| `LK_LLM_MODEL` | `google/gemma-4-31b-it` | rápido e barato |
| `LK_TTS_MODEL` | `gradium/default` | vozes pt-BR: Bianca, Mateus |
| `LK_TTS_VOICE` | `Bianca` | ajuste conforme o modelo |
| `LK_LANGUAGE` | `pt-BR` | aceita `pt`, `pt-BR`, `portuguese` |

Veja a lista atual em [docs.livekit.io/agents/models](https://docs.livekit.io/agents/models/).

## Contrato do metadata

O backend envia:

```json
{
  "kind": "crm-call",
  "callId": "uuid",
  "leadId": "uuid",
  "leadName": "Nome do contato",
  "company": "Empresa do lead",
  "phone": "5531...",
  "assistantName": "Sofia",
  "companyName": "Sua empresa",
  "context": "texto com cadastro, funil, interações..."
}
```

`agent.py` usa esses campos para montar as instruções e nunca inventa preço ou
condição fora do contexto.
