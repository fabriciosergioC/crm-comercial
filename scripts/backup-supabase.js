/* ---------------------------------------------------------------------------
   backup-supabase.js — cópia de segurança do banco do CRM, sem instalar nada.

   Usa a mesma SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY que o backend já lê do
   backend/.env, então não pede credencial na tela e não envia nada para fora:
   quem decide o destino é o seu disco (e o OneDrive, se a pasta estiver dentro
   de Documentos).

   Como as tabelas não são conhecidas de antemão — o projeto tem as 15 do CRM
   mais as de outros aplicativos — a lista é descoberta no próprio PostgREST
   (GET /rest/v1/ com Accept: application/openapi+json). Se essa leitura falhar,
   o script cai para a lista fixa das tabelas do CRM e avisa.

   Uso:
     node scripts/backup-supabase.js                    faz o backup agora
     node scripts/backup-supabase.js --listar           mostra os backups salvos
     node scripts/backup-supabase.js --restaurar <pasta>  grava de volta (pede confirmação)
     node scripts/backup-supabase.js --restaurar <pasta> --tabela leads
         repõe UMA tabela só — é o caminho para desfazer um apagão pontual
     node scripts/backup-supabase.js --restaurar <pasta> --limpar-antes
         apaga as linhas antes de gravar (destrutivo; só com confirmação digitada)
     node scripts/backup-supabase.js --manter 14        apaga os mais antigos, ficam 14

   O que o restore NÃO faz, para ninguém contar com o que não existe:
     - ele repõe LINHAS, não a estrutura: se a tabela sumiu do banco, é preciso
       criar ela primeiro (backend/database/banco_novo.sql);
     - ele não toca em Storage. O áudio que o cliente manda no chat fica num
       bucket do Supabase, e este backup é só do banco — o .json guarda a linha
       da mensagem, não o arquivo de som;
     - sem --limpar-antes é uma reposição, não uma volta-no-tempo: o que entrou
       no banco depois do backup continua lá;
     - as tabelas do CRM voltam na ordem de dependência (lead antes do
       histórico). Das 36 tabelas do outro aplicativo ninguém conhece as
       foreign keys aqui, então uma delas pode parar com erro de FK — o script
       avisa e segue a próxima, em vez de travar o restore inteiro.

   Nada aqui imprime a service_role key, nem o SQL, nem valor de senha.
--------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ARQUIVO_ENV = path.join(RAIZ, 'backend', '.env');
const PASTA_BACKUPS = path.join(RAIZ, 'backups', 'supabase');
const LINHAS_POR_PAGINA = 1000;
const LINHAS_POR_INSERT = 200;

/* As 15 tabelas do CRM, na ordem em que os pais precisam existir antes dos
   filhos (ver backend/database/schema.sql e migrations/014_financeiro.sql).
   Serve de fallback da descoberta e de guia para o --restaurar. */
const TABELAS_DO_CRM = [
  'users',
  'leads',
  'clients',
  'lead_status_history',
  'lead_interactions',
  'lead_followups',
  'lead_demos',
  'lead_proposals',
  'client_updates',
  'agenda_events',
  'whatsapp_conversations',
  'whatsapp_messages',
  'finance_sales',
  'finance_payments',
  'finance_settings',
];

/* ------------------------------------------------------------------ ambiente */

function carregarEnv() {
  try {
    require('dotenv').config({ path: ARQUIVO_ENV });
  } catch (erro) {
    require(path.join(RAIZ, 'backend', 'node_modules', 'dotenv')).config({ path: ARQUIVO_ENV });
  }
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) {
    console.error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY em ' + ARQUIVO_ENV);
    console.error('Confira se o backend/.env existe; o backup não pede credencial no chat.');
    process.exit(1);
  }
  return { url: url.replace(/\/+$/, ''), chave };
}

function criarCliente({ url, chave }) {
  let criar;
  try {
    criar = require('@supabase/supabase-js').createClient;
  } catch (erro) {
    criar = require(path.join(RAIZ, 'backend', 'node_modules', '@supabase', 'supabase-js')).createClient;
  }
  return criar(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });
}

/* -------------------------------------------------------------- descoberta */

async function descobrirTabelas({ url, chave }) {
  const cabecalho = { apikey: chave, Authorization: 'Bearer ' + chave, Accept: 'application/openapi+json' };
  const resposta = await fetch(url + '/rest/v1/', { headers: cabecalho });
  if (!resposta.ok) throw new Error('HTTP ' + resposta.status + ' ao ler a lista de tabelas');
  const spec = await resposta.json();
  const nomes = Object.keys(spec.paths || {})
    .map((caminho) => caminho.replace(/^\//, ''))
    .filter((nome) => nome && !nome.includes(',') && !nome.startsWith('rpc/'));
  return [...new Set(nomes)];
}

/* ------------------------------------------------------------------- backup */

function pastaDeAgora() {
  const d = new Date();
  const dois = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(), dois(d.getMonth() + 1), dois(d.getDate()),
    '-', dois(d.getHours()), dois(d.getMinutes()), dois(d.getSeconds()),
  ].join('');
}

async function copiarTabela(cliente, tabela, destino) {
  const todas = [];
  let pagina = 0;
  let ordenaPorId = true;

  for (;;) {
    let consulta = cliente.from(tabela).select('*');
    if (ordenaPorId) consulta = consulta.order('id');
    const { data, error } = await consulta.range(pagina * LINHAS_POR_PAGINA, (pagina + 1) * LINHAS_POR_PAGINA - 1);

    if (error) {
      /* Tabelas sem coluna `id` (junções e views do outro aplicativo) não
         aceitam o order; refazemos a página sem ordenar em vez de desistir. */
      if (ordenaPorId && /column .* does not exist|id/i.test(String(error.message || ''))) {
        ordenaPorId = false;
        continue;
      }
      throw new Error(error.message || 'código ' + error.code);
    }

    const lote = data || [];
    todas.push(...lote);
    if (lote.length < LINHAS_POR_PAGINA) break;
    pagina += 1;
  }

  fs.writeFileSync(destino, JSON.stringify(todas, null, 1));
  return { linhas: todas.length, bytes: fs.statSync(destino).size };
}

async function fazerBackup(conexao, cliente) {
  let tabelas;
  try {
    tabelas = await descobrirTabelas(conexao);
  } catch (erro) {
    console.warn('Não consegui listar as tabelas pelo PostgREST (' + erro.message + ')');
    console.warn('Usando a lista fixa das ' + TABELAS_DO_CRM.length + ' tabelas do CRM.');
    tabelas = TABELAS_DO_CRM;
  }

  const nome = pastaDeAgora();
  const pasta = path.join(PASTA_BACKUPS, nome);
  fs.mkdirSync(pasta, { recursive: true });

  console.log('Backup em ' + nome + ' — ' + tabelas.length + ' tabelas encontradas no projeto.');
  const relacao = [];
  const falhas = [];

  for (const tabela of tabelas.sort()) {
    const destino = path.join(pasta, tabela + '.json');
    try {
      const { linhas, bytes } = await copiarTabela(cliente, tabela, destino);
      relacao.push({ tabela, linhas, bytes, doCrm: TABELAS_DO_CRM.includes(tabela) });
      if (linhas > 0) console.log('  ' + tabela.padEnd(28) + linhas + ' linha(s)');
    } catch (erro) {
      falhas.push({ tabela, erro: String(erro.message || erro) });
      console.error('  ' + tabela.padEnd(28) + 'FALHOU: ' + (erro.message || erro));
    }
  }

  const totalLinhas = relacao.reduce((soma, r) => soma + r.linhas, 0);
  const manifesto = {
    geradoEm: new Date().toISOString(),
    /* Só o host, sem chave nenhuma: serve para conferir se o backup é do
       projeto certo antes de restaurar. */
    projeto: conexao.url.replace(/^https?:\/\//, ''),
    tabelas: relacao.length,
    linhas: totalLinhas,
    tabelasDoCrm: relacao.filter((r) => r.doCrm).length,
    tabelasDeFora: relacao.filter((r) => !r.doCrm).length,
    falhas,
  };
  fs.writeFileSync(path.join(pasta, 'manifest.json'), JSON.stringify(manifesto, null, 2));

  console.log('');
  console.log('Pronto: ' + totalLinhas + ' linha(s) em ' + relacao.length + ' tabela(s), ' + falhas.length + ' falha(s).');
  console.log('Pasta: ' + pasta);
  if (falhas.length) console.log('As tabelas que falharam ficam fora do manifesto — rode de novo depois de ver o motivo.');
  return pasta;
}

/* ---------------------------------------------------------------- restaurar */

function listarBackups() {
  if (!fs.existsSync(PASTA_BACKUPS)) {
    console.log('Nenhum backup ainda: ' + PASTA_BACKUPS + ' não existe.');
    return;
  }
  const pastas = fs.readdirSync(PASTA_BACKUPS)
    .filter((nome) => fs.existsSync(path.join(PASTA_BACKUPS, nome, 'manifest.json')))
    .sort();
  if (!pastas.length) {
    console.log('A pasta existe, mas não tem backup com manifest.json.');
    return;
  }
  console.log(pastas.length + ' backup(s) em ' + PASTA_BACKUPS + ':');
  for (const nome of pastas) {
    const m = JSON.parse(fs.readFileSync(path.join(PASTA_BACKUPS, nome, 'manifest.json'), 'utf8'));
    console.log('  ' + nome + '  ' + String(m.linhas).padStart(6) + ' linha(s)  '
      + String(m.tabelas).padStart(3) + ' tabela(s)  projeto ' + m.projeto
      + (m.falhas && m.falhas.length ? '  (' + m.falhas.length + ' falha(s))' : ''));
  }
}

/* Ordem do restore: as tabelas do CRM primeiro, na ordem de dependência, e o
   resto alfabeticamente depois. Assim um lead existe antes do histórico dele. */
function ordemDeInsercao(nomes) {
  const primeiro = TABELAS_DO_CRM.filter((t) => nomes.includes(t));
  const resto = nomes.filter((t) => !primeiro.includes(t)).sort();
  return [...primeiro, ...resto];
}

async function restaurar(conexao, cliente, pasta, { limparAntes, apenas }) {
  const caminhoManifesto = path.join(pasta, 'manifest.json');
  if (!fs.existsSync(caminhoManifesto)) {
    throw new Error('Sem manifest.json em ' + pasta + ' — não é uma pasta de backup deste script.');
  }
  const manifesto = JSON.parse(fs.readFileSync(caminhoManifesto, 'utf8'));
  if (manifesto.projeto !== conexao.url.replace(/^https?:\/\//, '')) {
    console.warn('AVISO: este backup foi feito do projeto ' + manifesto.projeto
      + ', e o .env atual aponta para ' + conexao.url.replace(/^https?:\/\//, '') + '.');
  }

  const nomes = fs.readdirSync(pasta)
    .filter((arquivo) => arquivo.endsWith('.json') && arquivo !== 'manifest.json')
    .map((arquivo) => arquivo.replace(/\.json$/, ''))
    .filter((tabela) => !apenas || !apenas.length || apenas.includes(tabela));

  if (limparAntes) {
    console.log('Apagando as linhas antes de restaurar (filhos primeiro)...');
    for (const tabela of [...ordemDeInsercao(nomes)].reverse()) {
      const { error } = await cliente.from(tabela).delete().neq('id', null);
      if (error) console.warn('  não consegui limpar ' + tabela + ': ' + (error.message || error.code));
    }
  }

  let total = 0;
  let comErro = 0;
  for (const tabela of ordemDeInsercao(nomes)) {
    const linhas = JSON.parse(fs.readFileSync(path.join(pasta, tabela + '.json'), 'utf8'));
    if (!Array.isArray(linhas) || !linhas.length) continue;
    /* Só tem como fazer upsert (atualizar sem duplicar) quem tem coluna `id`.
       As tabelas de junção do outro aplicativo não têm, então nelas o caminho
       é inserir — e se a linha já existir, o banco avisa em vez de duplicar. */
    const temId = linhas.every((linha) => linha && linha.id !== undefined && linha.id !== null);
    for (let i = 0; i < linhas.length; i += LINHAS_POR_INSERT) {
      const lote = linhas.slice(i, i + LINHAS_POR_INSERT);
      const { error } = temId
        ? await cliente.from(tabela).upsert(lote, { onConflict: 'id' })
        : await cliente.from(tabela).insert(lote);
      if (error) {
        comErro += 1;
        console.error('  ' + tabela + ': ' + (error.message || error.code) + ' — passei para a próxima tabela.');
        break;
      }
      total += lote.length;
    }
    console.log('  ' + tabela.padEnd(28) + linhas.length + ' linha(s) '
      + (temId ? 'gravada(s) por id' : 'inserida(s)')
      + (linhas.length ? '' : ''));
  }
  console.log('');
  console.log('Restauradas ' + total + ' linha(s) de ' + manifesto.geradoEm + (comErro ? ' — ' + comErro + ' tabela(s) pararam por erro.' : '.'));
  if (!limparAntes) {
    console.log('Como não usou --limpar-antes, o que estava no banco e não está no backup continua lá:');
    console.log('isto é uma reposição de linhas, não uma volta-no-tempo completa.');
  }
}

function confirmarZonaDestrutiva(mensagem) {
  /* Sem readline travando o .bat: pedimos a palavra no próprio console e, se
     alguém rodar sem interação, o script para em vez de apagar banco. */
  if (!process.stdin.isTTY) {
    console.error(mensagem);
    console.error('Rodando sem console interativo (ex.: Task Scheduler), o script NÃO apaga nada. Abra o .bat e digite.');
    process.exit(1);
  }
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolver) => {
    rl.question(mensagem + ' Digite RESTAURAR para continuar: ', (resposta) => {
      rl.close();
      resolver(String(resposta).trim().toUpperCase() === 'RESTAURAR');
    });
  });
}

/* ----------------------------------------------------------------- limpeza */

function manterApenas(quantidade) {
  if (!fs.existsSync(PASTA_BACKUPS)) return;
  const pastas = fs.readdirSync(PASTA_BACKUPS)
    .filter((nome) => fs.existsSync(path.join(PASTA_BACKUPS, nome, 'manifest.json')))
    .sort();
  const paraApagar = pastas.slice(0, Math.max(0, pastas.length - quantidade));
  for (const nome of paraApagar) {
    fs.rmSync(path.join(PASTA_BACKUPS, nome), { recursive: true, force: true });
    console.log('Apagado o backup antigo: ' + nome);
  }
  if (paraApagar.length) console.log('Ficaram ' + Math.min(quantidade, pastas.length) + ' backup(s).');
}

/* --------------------------------------------------------------------- main */

(async () => {
  const argumentos = process.argv.slice(2);
  const conexao = carregarEnv();
  const cliente = criarCliente(conexao);

  if (argumentos.includes('--listar')) {
    listarBackups();
    return;
  }

  const indiceRestaurar = argumentos.indexOf('--restaurar');
  if (indiceRestaurar >= 0) {
    const destino = argumentos[indiceRestaurar + 1];
    if (!destino) {
      console.error('Diga a pasta: node scripts/backup-supabase.js --restaurar backups/supabase/<nome>');
      process.exit(1);
    }
    const pasta = path.isAbsolute(destino) ? destino : path.join(PASTA_BACKUPS, destino);
    const limparAntes = argumentos.includes('--limpar-antes');
    const indiceTabela = argumentos.indexOf('--tabela');
    const apenas = indiceTabela >= 0 && argumentos[indiceTabela + 1] ? [argumentos[indiceTabela + 1]] : [];
    if (apenas.length && !fs.existsSync(path.join(pasta, apenas[0] + '.json'))) {
      console.error('Esta pasta de backup não tem a tabela "' + apenas[0] + '".');
      console.error('Rode com --listar e veja o que existe dentro dela.');
      process.exit(1);
    }
    if (limparAntes) {
      const liberado = await confirmarZonaDestrutiva(
        'VOCÊ VAI APAGAR as linhas atuais'
        + (apenas.length ? ' da tabela ' + apenas[0] : ' de todas as tabelas')
        + ' para gravar o backup ' + pasta.replace(/^.*[\\/]/, '') + '.');
      if (!liberado) {
        console.log('Cancelado: nada foi tocado no banco.');
        return;
      }
    } else {
      console.log('Restaurando por upsert (sem apagar nada que já existe). Use --limpar-antes para o replace completo.');
    }
    if (apenas.length) console.log('Somente a tabela ' + apenas[0] + '.');
    await restaurar(conexao, cliente, pasta, { limparAntes, apenas });
    return;
  }

  const indiceManter = argumentos.indexOf('--manter');
  const pasta = await fazerBackup(conexao, cliente);
  if (indiceManter >= 0) {
    const quantidade = Number(argumentos[indiceManter + 1]);
    if (Number.isFinite(quantidade) && quantidade > 0) manterApenas(quantidade);
  }
  console.log('');
  console.log('Dica: a pasta está dentro do projeto, então o OneDrive já sobe o backup sozinho.');
  console.log('Ela está no .gitignore — os dados dos clientes não vão para o GitHub.');
  return pasta;
})().catch((erro) => {
  console.error('Backup falhou: ' + (erro && erro.message ? erro.message : erro));
  if (erro && erro.cause && erro.cause.code) console.error('Causa: ' + erro.cause.code);
  process.exit(1);
});
