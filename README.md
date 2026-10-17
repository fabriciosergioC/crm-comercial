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
│       └── boot.js             ← compilador de boot (executa o app)
│
├── /_backup_original           ← cópia de segurança da fase anterior
│   └── Gestão Comercial CRM.html
│
├── run-crm.bat                 ← atalho: abre o frontend (e a API, se houver)
├── .gitignore
└── README.md
```

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
