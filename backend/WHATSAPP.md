# WhatsApp no CRM

O provider Baileys conecta ao WhatsApp Web e persiste conversas no Supabase.
Para desenvolvimento, também há um provider mock que não envia nem recebe
mensagens reais.

## Ativar o mock

No `backend/.env`, configure:

```env
WHATSAPP_PROVIDER=mock
```

Reinicie o backend e abra **WhatsApp** no CRM. O provider mock permite testar a
interface sem autenticar uma conta WhatsApp.

As conversas e mensagens do mock são mantidas apenas na memória do processo;
elas voltam aos exemplos iniciais quando o backend reinicia.

## Endpoints

- `GET /api/whatsapp/status`
- `POST /api/whatsapp/connect`
- `POST /api/whatsapp/disconnect`
- `GET /api/whatsapp/conversations`
- `POST /api/whatsapp/conversations/lead/:leadId` — abre ou cria a conversa de um lead cadastrado com telefone válido.
- `GET /api/whatsapp/conversations/:id`
- `POST /api/whatsapp/conversations/:id/messages`

Toda a integração passa por `WhatsAppService` e pela interface
`WhatsAppProvider`.

Na interface do WhatsApp, a aba **Leads** permite buscar contatos cadastrados e
abrir uma conversa usando o campo WhatsApp do lead ou, se estiver vazio, o
telefone. A conversa existente para o mesmo número é reutilizada.
O envio de mensagens exige que o WhatsApp esteja conectado.

## Teste

```powershell
node .\backend\scripts\test-whatsapp-mock.js
```
