# Gestão Comercial CRM

CRM de gestão comercial — aplicação 100% front-end, autocontida em um único
arquivo HTML (React + Babel + Tailwind, todos embutidos).

## Estrutura

```text
/crm
│
├── /frontend
│   ├── index.html              ← abrir este arquivo (HTML estrutural)
│   ├── index-original.html     ← cópia de segurança do arquivo único original
│   ├── /css
│   │   └── style.css           ← CSS (Tailwind compilado + painel de erro)
│   └── /js
│       ├── script.js           ← React + ReactDOM + Babel Standalone
│       ├── session.js          ← leva a sessão de login em toda chamada da API
│       └── boot.js             ← compilador de boot (executa o app)
│
├── /_backup_original           ← cópia de segurança da fase anterior
│   └── Gestão Comercial CRM.html
│
├── /backend
│   ├── server.js               ← API em http://localhost:3001 (liga com o run-crm.bat)
│   ├── /routes                 ← uma rota por recurso; /finance é o Financeiro
│   ├── /services               ← fala com o Supabase (routes → services → banco)
│   ├── /middleware             ← portão de sessão e tradução de erros
│   ├── /database/migrations    ← 001… até 014_financeiro.sql (colar no SQL Editor)
│   ├── .env                    ← chaves reais (fica só no notebook, nunca no GitHub)
│   └── .env.example            ← modelo com os campos vazios
│
├── run-crm.bat                 ← atalho: abre o frontend (e a API, se houver)
├── REINICIAR_CRM.bat           ← atalho: fecha a janela da API e abre o CRM de novo (código novo do backend)
├── ABRIR_PARA_A_EQUIPE.bat     ← atalho: abre o túnel ngrok para a equipe
├── .gitignore
└── README.md
```

## Deploy no Railway

O repositório inclui `railway.toml` para iniciar `npm start`, publicar o frontend
estático e a API Express na mesma origem e usar `/api/health` como health check.

Configure as variáveis no serviço Railway:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET` (valor aleatório estável com pelo menos 32 caracteres)
- `PORT` é fornecida automaticamente pelo Railway

Depois do deploy, verifique `https://SEU-DOMINIO/api/health`. Para persistência
de arquivos do WhatsApp/Baileys, monte um volume Railway e configure
`WHATSAPP_AUTH_DIR` para o diretório desse volume.

## Como usar

Basta abrir `frontend/index.html` no navegador. Não há build: o JSX é compilado
em tempo de execução. Todos os dados da tela vêm do backend e do Supabase.

Nunca há dado de exemplo na tela: com o `run-crm.bat` fechado, aparece o erro
real da conexão ("O backend não está rodando", com o endereço que foi tentado)
no lugar das telas do sistema, a tentativa se repete a cada 5 s e as telas
voltam sozinhas quando o backend responde — sem precisar recarregar. (O único
conteúdo de exemplo que resta é o botão "Importar dados demo", que só aparece
com o backend ligado, com a lista de leads vazia, e depende de um clique
explícito.)

Alternativamente, dê um duplo clique em `run-crm.bat`: ele instala as
dependências, inicia a API em uma janela separada (`http://localhost:3001/api`)
e abre o frontend servido localmente.

**Fechar painel com Esc.** Os painéis que abrem no topo — **Tema da tela** (o botão
da paleta) e o painel do **nome** (Trocar senha / Sair) — fecham com a tecla
**Esc**, a qualquer momento — inclusive logo depois de escolher um tema, que deixa
o painel aberto de propósito para poder comparar os cartões. No painel do nome o
Esc tem dois passos: com o formulário de senha aberto ele volta para os dois
botões, e o segundo Esc fecha o painel. O clique fora continua fechando pelo véu
transparente. Os ouvintes de teclado moram no `window` e só existem enquanto o
painel está aberto: presos dentro do painel eles só fechariam se o foco estivesse
lá dentro, e quem abre com o mouse nunca coloca foco em painel nenhum. É o mesmo
desenho do menu de **Etapa**/**Atendimento** e do menu de status do atendimento.
(Ficaram sem Esc o painel de sinos e o menu lateral do celular, que hoje também não
fecham por clique fora.)

## Leads

A lista de Leads tem cinco colunas: **Empresa**, **Status**, **Histórico**,
**Último contato** e **Ação** (mais o espaço do botão de WhatsApp na frente).
Não há coluna **Próxima ação** — ela foi tirada da lista para a tela respirar.
O dado continua no lead e continua aparecendo em três lugares: na ficha, no bloco
"Próxima ação — data e hora / o que fazer", nos cartões do **Pipeline**, e no menu
**Ordenar:**, onde "Próxima ação" ainda ordena a lista pela data agendada (é a
ordem padrão). As colunas podem ser arrastadas pela borda do cabeçalho (ou
ajustadas com as setas do teclado quando o separator está em foco).

**O padrão da tabela (medido no print).** As seis larguras de `LARGURAS_PADRAO_LEADS`
são o padrão que ele pediu para carregar: spacer **52**, Empresa **240** (elástica),
Status **176**, Histórico **300**, Último contato **155**, Ação **128**. Números
tirados do print dele, lidos pixel a pixel nas marcas "‖" do cabeçalho: bordas
direitas em 441,5 / 629,5 / 941,5 / 1108,5 e fim da tabela em 1249, com gap de 12px
entre colunas. A escala do print é 1:1 — confirmado pela coluna Ação, que é a única
sem alça e aparece com exatamente os 128px do código. Numa janela de 1274px isso dá
Empresa 338, Status 176, Histórico 300, Último contato 155, Ação 128, e foi conferido
na prévia: `[52, 338, 176, 300, 155, 128]`.

**Arrastar para os dois lados.** `minmax(200px, 1fr)` guarda 200 mas pode estar
ocupando 522px na tela: afinar o número guardado não mudava nada no que se vê, e a
alça parecia presa (só respondia quando se arrastava para a direita, passando dos
522). Agora, no instante em que a alça é pega, a **largura real da célula** é
medida (`getBoundingClientRect()`) e a coluna sai do grupo das que esticam — o
número volta a mandar e os dois lados do arraste funcionam. O espaço devolvido vai
para a coluna que ainda estica. O piso mínimo caiu de 90px para **64px** e o teto
subiu de 600px para 900px. A coluna Ação é a única sem alça: ela é a última e já
fecha no tamanho dos botões.

**Ajuste lembrado.** O que ele arrastar fica no navegador, na chave
`crm:largura-colunas-leads` do `localStorage` (as seis larguras + quais colunas
ainda esticam), e volta sozinho na próxima abertura — é isso que faz a página
"carregar padronizada". `lerLargurasSalvas()` só aceita seis números entre 32 e
2000px; se a chave estiver quebrada ou for de uma versão antiga, o app abre no
padrão acima em vez de montar uma tabela torta. **Duplo clique em qualquer alça**
volta ao padrão (e grava o padrão). O localStorage é por navegador e por endereço:
quem entra pelo link da equipe tem o seu próprio, e limpar os dados do navegador
zera o ajuste.

## Trocar a senha depois de entrar

Quem já está dentro do CRM troca a senha no próprio nome, no canto superior
direito. O clique no nome **não desloga mais**: ele abre um painel pequeno
(embaixo do nome, sem janela por cima da tela) com dois botões escritos —
**Trocar senha** e **Sair**. Em "Trocar senha" aparecem os três campos na hora
(*Senha atual*, *Nova senha* com no mínimo 8 caracteres, *Confirmar nova
senha*) e o botão **Salvar nova senha**.

- A troca vai no `POST /api/auth/change-password` com a senha atual no corpo do
  pedido. O backend confere a senha atual antes de gravar qualquer coisa: se ela não
  bate, a resposta é 401 e a tela mostra "Senha atual incorreta." — ninguém é
  deslogado, o painel continua aberto e nada muda no banco.
- Trocando certo, a pessoa **continua logada**: a resposta já vem com uma sessão
  nova (cookie + `sessionToken`) e o navegador troca a antiga por ela. Nada de
  senha fica salvo em tela, `localStorage` ou histórico.
- **Faixa de senha inicial** — enquanto o cadastro da pessoa ainda estiver com a
  senha inicial compartilhada (`users.must_change_password` diferente de `false`),
  aparece uma faixa laranja no topo de **todas** as telas, com o botão
  **Trocar minha senha** (abre os mesmos três campos ali mesmo) e **Agora não**.
  A faixa é aviso, não portão: ninguém é bloqueado de trabalhar por causa dela,
  "Agora não" só esconde até a próxima entrada, e ela some definitivamente no
  segundo em que a senha é trocada. A tela de entrada continua forçando a troca
  no primeiro acesso — a faixa é o caminho de quem já está dentro.
- É só frontend (`frontend/index.html`): depois de salvar o arquivo, **Ctrl+F5**
  no navegador basta — não precisa reiniciar o `run-crm.bat`.

## Financeiro (vendas, recebimentos e comissões)

O menu **Financeiro** (entre Clientes e WhatsApp) fecha o mês em quatro números:
**Vendido no mês**, **Recebido no mês**, **A receber** e **Comissão do mês**. As seções
são três guias — **Vendas**, **Recebimentos** e **Comissões** — uma na tela por vez. Ele não
cadastra cliente nem duplica venda:

- **Três guias na tela** — o Financeiro abre **uma seção por vez**: **Vendas**,
  **Recebimentos** e **Comissões** (é o estado `sec` em `FinanceiroView`; abre em
  Recebimentos, que é onde o trabalho do dia acontece). Os quatro números do topo ficam
  acima das guias, somam o mês inteiro e não mudam com a guia — e cada um deles é
  clicável: "Vendido no mês" abre Vendas, "Recebido no mês" e "A receber" abrem
  Recebimentos já com o chip certo, "Comissão do mês" abre Comissões. O botão
  **Receber** de uma venda troca para Recebimentos na guia de tipo do lançamento
  (tem mensalidade → Mensalidades; sem mensalidade → Implantação) antes de abrir o
  formulário, senão pareceria um botão morto. Nas vendas avulsas esse botão só aparece
  enquanto a venda não tem recebimento — veja o item abaixo.
- **Vendas** — as vendas dos Clientes fechados são lidas da própria guia Clientes
  (valor contratado + mensalidade) e aparecem aqui ao lado das vendas avulsas
  lançadas nesta tela. Nada é copiado: mudou no Cliente, mudou aqui.
- **Guia Vendas obedece ao período** — dentro da guia há a fila **Período:** com
  quatro chips (`JANELAS_VENDAS_UI` em `FinanceiroView`): **Deste mês** (padrão),
  **Últimos 3 meses**, **Este ano** e **Todas as vendas**. A janela é sempre contada a
  partir do **mês escolhido no topo**, nunca de hoje — voltar para Setembro/2026 e
  clicar "Este ano" mostra o ano de 2026. O texto ao lado dos chips diz
  "N de M vendas · <período>", o título do cartão e o número da guia **Vendas** usam o
  mesmo conta, então o selo da guia nunca promete mais linhas do que a lista mostra.
  Uma venda fechada **fora** da janela continua aparecendo quando tem recebimento
  **dentro** dela, marcada com a pílula **Recebimento em Outubro/2026** (o aviso de
  mouse diz a data real da venda e o valor recebido) — é a regra que ele escolheu, para
  o fechamento de setembro não sumir da tela de outubro quando a implantação cai em
  outubro. Quando o mês não tem nada, a tela vazia diz o período e manda trocar o chip
  ou as setas do topo. E ao **lançar uma venda avulsa** com data fora da janela, o mês
  do topo vai junto para o mês da venda e o aviso diz isso, senão o botão pareceria
  quebrado. Os quatro números do topo continuam sendo do mês escolhido (não mudam com
  o chip), como sempre.
- **Cada chip diz quantas vendas ele traz, e a última escolha fica lembrada** — os
  chips escrevem o número dentro do rótulo ("Deste mês (2)", "Este ano (10)"), porque
  ele pediu para escolher pelo número e não no escuro; a conta é a mesma da lista
  (`linhasDaJanela(filtro)` em `FinanceiroView`, então o "(2)" e as duas linhas que
  aparecem são sempre o mesmo conjunto). A janela escolhida vai para
  `localStorage` na chave `crm:filtro-periodo-vendas` (`salvarFiltroVendasEscolhido`) e
  volta na próxima vez que ele abre o Financeiro (`useState(lerFiltroVendasSalvo)`) —
  do mesmo jeito que as larguras das colunas dos Leads ficam no navegador. É escolha
  de tela, não de banco: sem memória local disponível a tela segue funcionando com o
  padrão **Deste mês**.
- **Venda avulsa se cobra uma vez só** — o botão **Receber** da linha some assim que
  existe um recebimento daquela venda (helper `recebimentosDaAvulsa` em
  `FinanceiroView`: `p.saleId === s.id && p.status !== "Cancelado"`), no lugar dele
  fica uma pílula escrita: **Já recebida** quando todos os lançamentos dela estão
  pagos, **A receber** enquanto houver algum pendente — passando o mouse ela diz
  quantos lançamentos e o total. Isto vale só para venda avulsa: linha de **Cliente**
  mantém o botão enquanto a cobrança for mensalidade (que se repete todo mês) e não
  tiver a implantação do mês na frente — ver o item abaixo. O botão também volta
  quando o único lançamento da venda é **Cancelado** (cancelar equivale a não ter
  cobrado — a venda continua ativa e não há soma dela no mês). Quem precisa cobrar de
  novo não ficou sem caminho: a venda avulsa continua listada no seletor
  **"Novo recebimento"** da guia Recebimentos, no grupo *Vendas avulsas*.
- **Implantação se cobra uma vez por mês** — a segunda implantação do mesmo cliente no
  mesmo mês é sempre lançamento duplicado, e era assim que o dinheiro saía dobrado do
  mês. O banco só trava mensalidade repetida (índice único de `client_id + period`),
  porque cobrança extra de mensalidade é legítima — então a implantação é barrada no
  service: `assertUnicaImplementacao` em `backend/services/financeService.js`, chamada
  na **criação** e também na **edição** (mudar o vencimento para um mês que já tem
  implantação dele recebe o mesmo **409**, e a própria linha sendo editada é ignorada).
  A mensagem é a que aparece na tela: *"A implantação de Outubro/2026 já foi lançada
  para <cliente>. Cancele o lançamento existente para poder cobrar de novo."* — assim
  quem entra pelo link da equipe também não duplica pela API. Na tela a barra vem
  antes, em dois lugares:
  - **Guia Vendas**: quando o **Receber** daquela linha lançaria uma implantação que
    já existe no mês, o botão não fica morto nem vai dar erro — sai de cena e entram a
    pílula **Implantação de Outubro/2026 lançada** (ou **recebida**, se já está paga),
    o botão **Ver lançamento** e o botão **Cancelar implantação** na própria linha.
    Pendente cancela na hora (não mexe em dinheiro que entrou); **paga** abre o campo
    de **senha inline na linha** — é o mesmo `CampoConfirmacaoSenha` do recebimento,
    conferida no servidor. Cancelada, a pílula some e o **Receber** volta, que é o
    caminho que ele escolheu para corrigir valor ou data.
  - **Formulário de novo recebimento**: escolhendo cliente + tipo Implementação com um
    mês que já tem implantação dela, aparece o aviso âmbar com valor, situação e
    vencimento do lançamento que está no caminho, o botão **Lançar recebimento** fica
    desabilitado, e **Ver a linha para cancelar** fecha o formulário, salta para a guia
    Recebimentos na aba Implantação com o filtro **Todos**, acende a linha e a traz
    para o meio da tela (`focoLancamento` + `data-lancamento` + `scrollIntoView`).
  O mês do lançamento é o mesmo que a tela já usa para somar: mensalidade no mês do
  topo (`period`), os outros tipos pelo vencimento (`monthKeyOf(dueDate || hoje)`), e
  lançamento **Cancelado** nunca conta.
- **Recebimentos** — cada parcela entra como uma linha, apontando para um cliente
  **ou** para uma venda avulsa (nunca os dois, nunca nenhum), e dentro da guia
  Recebimentos a lista é separada em **três guias de tipo** para não misturar as
  coisas: **Mensalidades** (tipo Mensalidade),
  **Implantação** (tipo Implementação) e **Avulsos** (Serviço avulso e Outro, e também
  qualquer lançamento sem tipo). Os números ao lado de cada guia são quantos
  lançamentos daquele grupo aparecem no filtro escolhido; os chips de situação
  (Deste mês, A receber, Atrasadas, Pagas, Canceladas, Todos) contam só dentro da guia
  aberta. Abaixo dos chips, a faixa **"Somas de <guia>"** mostra Recebido / A receber /
  Atrasado **só daquela guia**, com as mesmas regras dos chips — é assim que o valor da
  implantação não se mistura com o da mensalidade (os quatro números do topo continuam
  somando tudo). "Gerar mensalidades" cria a parcela do mês de cada cliente ativo com
  mensalidade maior que zero, pula para a guia Mensalidades, e rodar de novo não
  duplica: o banco barra o segundo lançamento do mesmo cliente no mesmo mês e a tela
  diz quantos já tinham.
- **Comissão** — um percentual único, editável na própria tela (o campo "% sobre o
  recebido"), que vale também para quem entra pelo link da equipe. Comissão só conta
  o dinheiro que entrou: venda ainda não recebida não gera comissão, e o total é
  dividido por responsável.
- **Excluir x Cancelar** — no recebimento há os dois botões. **Excluir** apaga a linha
  do banco de verdade (`DELETE /api/finance/payments/:id`), e só serve para lançamento
  digitado errado: a linha abre o campo de **senha**, mostra nome, valor e vencimento,
  avisa que não tem como recuperar, e a linha sai das somas e das comissões.
  **Cancelar** guarda o histórico (vira "Cancelado" e continua na lista em "Canceladas").
  Venda avulsa não tem exclusão — errada vira "Cancelada". Atraso não é status: é a data
  de vencimento comparada com hoje, calculado na tela.
- **Senha nos dois atos sem volta** — **Excluir**, **Desfazer** (o pagamento que já
  entrou volta para "A receber") e **Cancelar** de um lançamento **pago** pedem a senha
  da pessoa. Ela vai no cabeçalho `x-crm-senha` (junto com `x-crm-usuario`) e é conferida
  no servidor por `usersService.authenticate`, o mesmo serviço do login
  (`backend/routes/financeRoutes.js`): sem senha, com senha errada ou sem identificar o
  usuário, a rota responde **401** e nada muda no banco — a tela mostra a mensagem real
  do servidor e o campo fica aberto para tentar de novo. A senha não fica salva em lugar
  nenhum: limpa o campo assim que o pedido termina, e errar não fecha a linha. Marcar
  como pago, ajustar vencimento/método e cancelar um lançamento ainda **a receber**
  continuam sem senha, porque não reescrevem dinheiro que já caiu. Vale igual para quem
  entra pelo link da equipe: cada um confirma com a própria senha.

Antes de usar, cole a migration no banco:

1. Abra o **SQL Editor** do seu projeto no Supabase, cole o conteúdo inteiro de
   `backend/database/migrations/014_financeiro.sql` e execute. Uma vez só basta (o
   arquivo pode rodar de novo sem estragar nada).
2. Feche e reabra o `run-crm.bat` — ou dê dois cliques em **`REINICIAR_CRM.bat`**, que
   fecha sozinho a janela da API (somente o processo que está na porta 3001) e chama o
   `run-crm.bat`. Nada no Supabase é tocado por esse atalho. As rotas novas
   (`/api/finance/...`, inclusive o `DELETE` e a checagem de senha) só existem depois de
   reiniciar o backend: enquanto ele for mais velho que os arquivos da pasta `backend`, a
   tela mostra o campo de senha mas a API antiga finge que ela não existe — e "Excluir"
   responde "Rota não encontrada.".
3. No navegador, `Ctrl+F5`.

Sem esses passos a tela abre mesmo assim: as vendas dos clientes aparecem e um aviso
âmbar explica que ainda faltam as tabelas — "Gerar mensalidades", "Novo recebimento",
"Excluir" e o percentual ficam bloqueados. Depois de colar a migration e reiniciar o
`run-crm.bat`, é só clicar em "Tentar de novo".

Cuidado com um cliente que já tem recebimento lançado: as linhas do Financeiro
apontam para ele (`finance_payments.client_id`), então ele não pode sumir do banco
deixando lançamento órfão. Fora o "Excluir" do recebimento errado, o CRM não apaga
nada por decisão — é assim que a prova de quem vendeu o quê fica de pé.

## Abrir o CRM para a equipe (ngrok)

Deixe o `run-crm.bat` aberto e dê dois cliques em `ABRIR_PARA_A_EQUIPE.bat`: o
ngrok mostra um endereço `https://....ngrok`. Quem receber esse link cai na tela
de senha do CRM e, depois de entrar, usa o sistema normalmente — ninguém copia
token nem instala nada.

A partir daqui o backend exige a sessão de login em toda rota de dados
(`backend/middleware/sessionGate.js` + `backend/services/sessionTokens.js`): sem
sessão válida a resposta é 401 e o navegador volta para a tela de entrada
(`frontend/js/session.js`). O seu `localhost` continua isento, então você nunca
fica trancado fora do seu próprio notebook. Fechar a janela do túnel desliga o
acesso na hora. Riscos, endereço fixo grátis e como criar o login de cada pessoa
estão em `HOSPEDAGEM.md`.

## Backend

A busca de empresas usa OpenStreetMap por padrão e não exige chave de API.
Para selecionar Google Places na tela de enriquecimento, configure
`GOOGLE_PLACES_API_KEY` em `backend/.env`. Os recursos que persistem dados
comerciais e o WhatsApp exigem `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`
no mesmo arquivo. Copie esses valores das configurações do seu projeto
Supabase e reinicie `run-crm.bat`; sem eles, o CRM avisa na tela que o backend
está de pé mas o banco não está configurado, e nenhuma tela de dados abre.

## Notas técnicas

- O código da aplicação (JSX) permanece dentro de
  `<script type="text/plain" id="app-source">` no `index.html` e é compilado
  em tempo de execução por `js/boot.js` (Babel Standalone, carregado via
  `js/script.js`). Extraí-lo exigiria fetch assíncrono (não funciona via
  `file://`), alterando a lógica de inicialização.
- A aplicação não tem mais modo local com dados de demonstração: sem o backend
  respondendo no `/api/health`, nenhuma tela de dados é montada e o estado
  interno começa vazio. O aviso fica na tela até a próxima resposta (tentativa a
  cada 5 s e também quando a aba volta a ficar visível).
- Nenhuma lógica foi alterada na separação: `css/style.css`,
  `js/script.js` e `js/boot.js` são cópias byte a byte dos blocos originais
  (verificado por hash SHA-256), na mesma ordem de carregamento.
- Data de calendário (vencimento, data da venda, dia do relatório) viaja como chave
  `YYYY-MM-DD` e é coluna `date` no Postgres. Ela nunca vira `Date` com hora UTC: no
  fuso de Ipatinga (-03) isso mostraria o dia anterior na tela. O mesmo vale para o
  "está atrasado?", que compara as chaves, não objetos de data.
- Toda classe nova usada no JSX precisa ser escrita à mão no fim de
  `frontend/css/style.css` (não há build do Tailwind): classe que não existe no CSS
  simplesmente não faz nada, sem erro.
- Tudo no Financeiro é otimista menos os três atos que pedem senha: `Excluir`,
  `Desfazer` e `Cancelar` de um lançamento pago esperam a resposta do servidor para então
  mudar a tela (`DELETE /api/finance/payments/:id` ou `PATCH` com `x-crm-senha`). O
  service devolve 404 quando o id não existe (nada de sucesso falso), e o 401 de senha
  errada **não** derruba a sessão — só o portão do ngrok emite `sessionExpired`. Por isso
  o `PATCH` desfazido entra no estado pelo case novo `FINANCE_PAYMENT_SECURED`, que é só
  de tela: se usasse o `UPDATE_FINANCE_PAYMENT` de sempre, o espelho do Supabase
  reenviaria o mesmo `PATCH` sem a senha e o backend responderia 401 depois de a tela já
  ter mudado. O `DELETE` do recebimento é um dos três únicos do CRM — os outros são o
  lead sem cliente vinculado e a conversa vazia; venda, cliente, follow-up e proposta
  continuam sem exclusão.
