# CRM + WhatsApp via Baileys

Esta versão do CRM usa Baileys em vez da WhatsApp Cloud API.

- Interface de atendimento dentro do CRM
- Conexão por QR Code ou Pairing Code
- Sessão persistente em `data/whatsapp-auth`
- Recebimento de mensagens em tempo real
- Envio de mensagens pelo CRM
- Histórico salvo no Supabase
- Sem Cloud API da Meta
- Sem webhook da Meta

## Instalação rápida no Windows

1. Tenha Node.js 20+ instalado.
2. Execute `INSTALAR_BAILEYS.bat`.
3. Configure `backend/.env` com as credenciais do Supabase.
4. Execute `run-crm.bat`.
5. Abra a seção WhatsApp.
6. Para autenticar pelo celular, informe o número com DDI no campo antes de
   clicar em **Conectar WhatsApp**; use o código em WhatsApp → Configurações →
   Dispositivos conectados → Conectar dispositivo → Conectar com número de telefone.
7. Sem número, escaneie o QR Code exibido na tela do CRM usando
   WhatsApp → Dispositivos conectados → Conectar dispositivo. Se a conexão não
   responder em até 30 segundos, o CRM informa a falha e permite tentar novamente.

## Atenção

Baileys é uma biblioteca não oficial para interação com o WhatsApp Web. Ela não é afiliada ao WhatsApp. O próprio projeto recomenda não usar a biblioteca para spam, disparos em massa ou automação abusiva.

## Geração de áudio por IA no chat

O chat inclui o botão **Gerar áudio com IA**. Para habilitá-lo, configure no `.env` carregado pelo backend:

```env
ELEVENLABS_API_KEY=sua_chave
ELEVENLABS_VOICE_ID=id_da_voz
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
```

Reinicie o backend depois de salvar as variáveis. O atendente digita o texto, gera e escuta a prévia e, se estiver correta, clica em **Enviar nota de voz**. O backend gera MP3 pela API de voz e aproveita o conversor FFmpeg existente para preparar OGG/Opus antes de enviar via Baileys.

Ao lado do botão há um seletor com os perfis devolvidos por `GET /api/whatsapp/tts/profiles`:

| Perfil | Modelo | Para que serve |
| --- | --- | --- |
| **Rápida** (padrão) | `ELEVENLABS_MODEL_ID` | turbo/flash: gasta pouco crédito e responde na hora |
| **Natural** | `TTS_NATURAL_MODEL_ID` (padrão `eleven_v3`) | mais humana, com respiradas; marcada com "gasta mais crédito" |

A escolha fica salva no navegador do atendente (`localStorage`) e é enviada como `profile` no corpo de `/tts/preview`. Modelos extras podem ser publicados como perfis em `backend/services/ttsService.js` (`VOICE_PROFILES`), regulados pelas variáveis `TTS_NATURAL_*` e `TTS_DEFAULT_PROFILE`.

No perfil **Natural** dá para dirigir a fala escrevendo tags no próprio texto — `[pause]`, `[excited]`, `[curious]`, `[calm]`, `[whisper]` (lista em `TTS_V3_TAGS`). Qualquer outro trecho entre colchetes é descartado antes do envio, e um placeholder esquecido como `[NOME]` faz a geração falhar com aviso para preencher, em vez de falar o colchete.

A chave e o ID da voz ficam somente no backend. A geração depende de uma conta/API de voz com acesso e saldo/limite disponíveis. A rota aceita textos de até 3.000 caracteres e o áudio gerado fica limitado a 8 MB.
