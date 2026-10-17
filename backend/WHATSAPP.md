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
- `POST /api/whatsapp/conversations/:id/messages/media?kind=image|audio` — recebe imagem ou áudio binário (máximo 8 MB); `caption` opcional para imagem.
- `POST /api/whatsapp/conversations/:id/history` — pede ao celular as mensagens
  anteriores desta conversa (`quantity` no corpo ou na query, 1 a 200, padrão 50).
  A resposta volta na hora; as mensagens chegam segundos depois pelo `messages.upsert`.
- `GET /api/whatsapp/conversations/:id/messages/:messageId/audio` — devolve `{ url }` assinado do áudio do cliente guardado no Storage (404 quando a mensagem não tem áudio salvo).

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
No chat, imagens JPEG/PNG/WebP e áudios OGG/MP3/M4A/WebM/WAV podem ser
selecionados e enviados pelo Baileys; o microfone também pode gravar áudio no
navegador. Antes do envio, os áudios são convertidos para OGG/Opus mono para
compatibilidade com os clientes WhatsApp. A conversão usa o binário incluído
por `ffmpeg-static`; a ponte inclui esse binário no executável autocontido. Os
arquivos são transmitidos ao WhatsApp e não ficam armazenados no
banco do CRM; no histórico local fica um marcador (`[Imagem enviada]` ou
`[Áudio enviado]`).

## Áudio que o CLIENTE manda (ouvir e transcrever)

Antes, o áudio recebido virava só a palavra `[Áudio]` na conversa: ninguém ouvia
e a IA não lia. Agora, ao chegar um `audioMessage`, o
`services/whatsapp/incomingAudioService.js` faz três coisas em sequência:

1. Baixa o arquivo do WhatsApp (`downloadMediaMessage`, OGG/Opus do próprio
   cliente, até 16 MB) e sobe para o Storage do Supabase, na pasta particular
   `whatsapp-audio`, no caminho `<idDaConversa>/<idDaMensagem>.ogg`. A pasta é
   criada automaticamente na primeira mensagem de voz se ainda não existir.
2. Transcreve na Groq (`whisper-large-v3-turbo`, que aceita OGG/Opus direto, sem
   FFmpeg). Só a nota de voz do cliente é transcrita; arquivo de áudio mandado
   como música (`ptt = false`) fica guardado apenas para tocar.
3. Reescreve o `content` da mensagem no banco com o texto, precedido do marcador
   `🎧 `. Sem transcrição, o texto vira `[Áudio do cliente — transcrição
   indisponível]`, e o player continua funcionando.

Não há migração nova: o caminho do arquivo é deduzido de
`(conversation_id, message_id)` e "tem áudio" é lido pelo marcador. O link
assinado do Storage (1 hora, configurável em `SUPABASE_AUDIO_URL_TTL`) é pedido
somente no primeiro clique em **Tocar**, porque a conversa é recarregada o tempo
todo e cada assinatura seria um pedido ao Supabase; o navegador guarda o resultado.
Apagar a conversa apaga a pasta dela no Storage.

O texto transcrito também entra no contexto das sugestões de resposta como
`Cliente (mandou áudio, transcrito): ...`, e o prompt tem um bloco próprio para
esse caso. Áudios recebidos antes disto continuam sem arquivo: a rota devolve
404 com a explicação de pedir para o cliente mandar de novo.

## O que já estava no WhatsApp (envios pelo celular e mensagens antigas)

Antes só apareciam no CRM as mensagens enviadas por ele próprio. Agora:

**Tudo o que você digita no app do celular também entra.** O WhatsApp multi-device
copia para o servidor cada mensagem enviada (`key.fromMe = true`), e essa cópia era
descartada. Ela agora é gravada como mensagem enviada, com
`sent_by = "WhatsApp do celular"` — é essa string que a bolha do chat lê para escrever
"pelo celular" embaixo da hora. Se um dia o nome mudar no backend, mude junto no
frontend (`ENVIADA_PELO_CELULAR` em `frontend/index.html`).

**Nada se repete.** O `id` de `whatsapp_messages` é o próprio ID da mensagem no
WhatsApp, então quando a cópia do celular chega junto com o registro do CRM, o
banco devolve `23505` e a linha é ignorada. O envio pelo CRM grava com `upsert`
(`onConflict: id`) para vencer essa corrida e manter quem realmente digitou.

**Um envio do CRM nunca abre segunda conversa.** O ID da mensagem é gerado antes
do `sendMessage` e passado na opção `messageId` do Baileys, e a linha entra no
banco antes de o envio começar. Isso importa porque a cópia (`fromMe`) que volta
nem sempre vem com o JID para onde mandamos: o WhatsApp às vezes devolve o
número sem o 9º dígito, ou um LID. Antes, essa cópia criava uma conversa vazia
com aquele outro número e o cliente aparecia duas vezes no menu do WhatsApp.
`persistirMensagem` agora procura o ID da mensagem primeiro e reaproveita a
conversa que já tem aquela linha. Mensagem do CRM para o PRÓPRIO número (os
lembretes de follow-up) também não vira conversa.

**Número do lead com o 9º dígito errado não abre segunda conversa.** O mesmo
celular brasileiro existe de dois jeitos: `55 31 8507-2952` e `55 31 98507-2952`.
O lead costuma ser captado com um (Google Places mostra o número sem o 9) e o
WhatsApp do cliente é o outro, então abrir conversa pelo número do cadastro
criava a segunda ficha do mesmo cliente no menu. Em
`WhatsAppService.openLeadConversation`: se a conversa do número do lead **não tem
nenhuma mensagem** e a conversa do número irmão (`irmaDoNove` em `phoneUtils.js`)
tem, o atendimento abre na irmã e o `whatsapp` do lead é corrigido para o número
que tem conversas. A conversa com mensagens sempre manda: se a do número do lead
já tem mensagens, nada é trocado.

**A RESPOSTA do cliente também não abre chat irmão.** O parágrafo acima só valia
para o caminho do lead; a mensagem que chega pelo `messages.upsert` procurava
apenas o número EXATO e, se não achava, inseria conversa nova — era isso que
deixava dois chats do mesmo cliente (um com o 9, outro sem). Agora
`ensureConversation` (chamado por `persistirMensagem` e pelo lote de histórico),
antes de INSERIR, consulta `conversaIrma(phone)`: se existe ficha no número
irmão, a mensagem entra nela. Nenhum número novo nasce no menu por resposta de
cliente. `irmaDoNove` só aceita celular (assinante começando em 8 ou 9), então
telefone FIXO não funde com o celular de outra pessoa que por acaso difere só
pelo 9.

**A ficha VAZIA do número irmão é renomeada para o número que tem tráfego.** Se a
ficha que acabou de ser reaproveitada é a irmã e ela não tem nenhuma mensagem
(fantasma nascida do número do cadastro), `reancorarNumero` troca o `phone` dela
pelo número que o cliente está usando de verdade — sobra uma ficha só, já com o
número certo, e o número morto some do menu. Se já existe outra conversa com
aquele número, a troca é abortada (`reancorarNumero` devolve `false`) e a
mensagem continua entrando na ficha que já era usada.

**Ficha exata vazia perde para a irmã com histórico.** `ensureConversation` não
para mais no `eq("phone", clean)`: se a ficha do número exato existe mas tem zero
mensagens e a irmã tem, a mensagem vai para a irmã (mesma regra do lead, agora no
caminho da mensagem), senão o histórico do mesmo cliente ficaria dividido entre
duas fichas. Nenhum dos dois casos renomeia ficha com mensagens — trocar o número
a cada mensagem faria ele pular de um lado para o outro entre as duas formas do
mesmo celular. `MockWhatsAppProvider.openLeadConversation` espelha as três regras
para que a prévia e os testes de mock vejam o mesmo comportamento (`%TEMP%\teste-import-whatsapp.js`
62 conferências, `%TEMP%\teste-mock-renomeia.cjs` 8).

**Envio pelo número que o WhatsApp confirma.** `resolverDestino(phone)` testa o
número da ficha, o irmão de 9º dígito e o JID visto na última mensagem deste
contato, e envia pelo que o `onWhatsApp` responder exists — antes, uma ficha
com o número incompleto dava "Este número não foi encontrado no WhatsApp" para
um cliente que responde todo dia. Quando o número da ficha não existe e o irmão
existe, `reancorarNumero` corrige o `phone` da conversa (só se não houver outra
ficha naquele número) e o JID real fica guardado no `chatJidStore`.

**Histórico não bagunça o atendimento.** Lote antigo (evento
`messaging-history.set`) e mensagens velhas que chegam pelo `messages.upsert`
entram na conversa, mas não mudam o status nem o contador de não lidas: isso só
acontece com mensagem "viva" (dos últimos 5 minutos). Grupos ficam de fora — a
importação é só de conversa com pessoa.

**Botão "Puxar mensagens antigas" (relógio no cabeçalho do chat).** O CRM chama
`fetchMessageHistory` do Baileys, que é um pedido ao celular, e usa como âncora a
mensagem mais antiga que ele tem daquela conversa (a que tem `provider_message_id`).
O celular responde em segundos com o lote, e o chat reabre a conversa sozinho até
as mensagens aparecerem — por isso o aviso diz quantas chegaram, e não o resultado
do clique.

Dois limites honestos, ambos escolha sua (você optou por não desconectar e
parear de novo):

- Conversa que o CRM **nunca** viu (zero mensagens) não tem âncora, então a rota
  devolve 409 explicando. Trazer tudo de uma vez só no pareamento com histórico
  completo — e o importador acima já está pronto para receber esse lote sem código novo.
- Áudio, imagem e arquivos antigos não foram baixados na época: o que volta é o
  texto. Só as notas de voz recebidas **a partir de agora** têm arquivo para tocar.

O `data/whatsapp-jids.json` (opcional, `WHATSAPP_JID_STORE`) guarda o JID real de
cada chat. Ele é necessário porque o WhatsApp às vezes identifica a conversa por
um `@lid` em vez do número, e o pedido de mensagens antigas precisa do JID que o
celular usa. Não é banco e não vai para o GitHub (o `/data/*.json` do `.gitignore`
cobre o arquivo).

## Teste

```powershell
$env:WHATSAPP_PROVIDER="mock"
node .\backend\scripts\test-whatsapp-mock.js
```

O script cobre o ciclo de vida dos status (transições automáticas, mudança
manual, validação 400 e as rotas `PATCH /status` e `POST /open`).
