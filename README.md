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

Basta abrir `frontend/index.html` no navegador.
Não há build, servidor, dependências ou banco de dados — todos os dados são
de demonstração, em memória.

Alternativamente, dê um duplo clique em `run-crm.bat`: ele confere o Node.js,
abre o frontend no navegador e, **quando a API do backend estiver completa**,
sobe a API em uma janela separada (`http://localhost:3001/api`) e cria o
`backend/.env` na primeira execução. Se o backend não estiver utilizável, o
script avisa e segue apenas com o frontend — que é o caso hoje.

## Backend (em construção)

`backend/` traz a API Express + Supabase (`config`, `middleware`, `models` e
`services`), mas ainda não tem a camada de rotas (`backend/routes`, importada
por `server.js`) nem o `backend/database/schema.sql` citado pelos services.
Enquanto isso, `node server.js` falha com `Cannot find module './routes'` — por
isso o `run-crm.bat` apenas avisa e segue com o frontend.

## Notas técnicas

- O código da aplicação (JSX) permanece dentro de
  `<script type="text/plain" id="app-source">` no `index.html` e é compilado
  em tempo de execução por `js/boot.js` (Babel Standalone, carregado via
  `js/script.js`). Extraí-lo exigiria fetch assíncrono (não funciona via
  `file://`), alterando a lógica de inicialização.
- A camada de serviços está preparada (em comentários) para uma futura
  integração com Supabase — hoje o frontend funciona 100% em memória e não
  chama a API (`backend/` é apenas o esqueleto descrito acima).
- Nenhuma lógica foi alterada na separação: `css/style.css`,
  `js/script.js` e `js/boot.js` são cópias byte a byte dos blocos originais
  (verificado por hash SHA-256), na mesma ordem de carregamento.
