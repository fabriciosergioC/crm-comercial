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
- `POST /api/whatsapp/conversations/:id/open` — atendente abriu a conversa; aplica a transição de abertura e devolve o histórico.
- `PATCH /api/whatsapp/conversations/:id/status` — corpo `{ "status": "Resolvido" }`; só aceita os estados abaixo (400 fora disso).
- `POST /api/whatsapp/conversations/:id/messages`

Toda a integração passa por `WhatsAppService` e pela interface
`WhatsAppProvider`.

## Status da conversa

Ciclo de vida operacional definido em
`services/whatsapp/conversationStatus.js` (o front-end espelha a mesma lista em
`CONVERSATION_STATUSES`):

| Status | Significado |
|---|---|
| 🟡 Novo | Cliente acabou de entrar em contato |
| 🔵 Atendimento iniciado | Atendente está conversando com o cliente |
| 🟣 Aguardando resposta | Atendente respondeu e está esperando o retorno |
| 🟠 Respondido | Cliente respondeu e precisa de ação do atendente |
| ✨ Demo Enviada | Demonstração enviada ao cliente |
| 🟢 Resolvido | Atendimento concluído |
| 🔴 Cancelado | Atendimento encerrado sem solução |
| ⚫ Arquivado | Conversa encerrada e retirada da fila |

Transições automáticas: mensagem **recebida** -> `Respondido` (fica
`Novo` se ninguém ainda atendeu), mensagem **enviada** -> `Aguardando resposta`,
**abertura** da conversa pelo atendente -> `Atendimento iniciado`. `Resolvido`,
`Cancelado` e `Arquivado` são escolhidos à mão no menu do chat e não mudam
sozinhos, exceto quando chega uma mensagem nova (a conversa volta para
`Respondido`). `Demo Enviada` é selecionado manualmente no menu do chat.
Rótulos antigos, como `Em atendimento`,
`Aguardando cliente` e `Aguardando atendente` são convertidos na leitura; a migração
`migrations/007_whatsapp_conversation_status.sql`
alinha o dado persistido e passa o padrão da coluna para `Novo`. A migração
`migrations/009_whatsapp_status_labels.sql` restaura `Aguardando resposta` caso a
migração anterior já tenha sido aplicada e renomeia `Aguardando atendente` para
`Respondido` nos dados já persistidos.

Na interface do WhatsApp, a aba **Leads** permite buscar contatos cadastrados e
abrir uma conversa usando o campo WhatsApp do lead ou, se estiver vazio, o
telefone. A conversa existente para o mesmo número é reutilizada.
O envio de mensagens exige que o WhatsApp esteja conectado.

## Teste

```powershell
$env:WHATSAPP_PROVIDER="mock"
node .\backend\scripts\test-whatsapp-mock.js
```

O script cobre o ciclo de vida dos status (transições automáticas, mudança
manual, validação 400 e as rotas `PATCH /status` e `POST /open`).
