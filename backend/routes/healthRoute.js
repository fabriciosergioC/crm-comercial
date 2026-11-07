const express = require('express');
const dns = require('dns').promises;
const { supabase, isConfigured } = require('../config/supabase');
const { motivoFalhaDoBanco } = require('../services/modelHelpers');

const router = express.Router();

/* ---------------------------------------------------------------------------
   /health costumava dizer "database: configurado" só porque as duas linhas
   existem no .env. Resultado: com o projeto do Supabase fora do ar, a tela
   jurava que o backend estava ótimo, disparava os 12 pedidos de dados e
   mostrava "respondeu 0 de 12" — e reiniciar o run-crm.bat não tinha jeito,
   porque ele estava perfeito. Agora o /health faz uma consulta real.

   Detalhes que importam:
   - responde 200 SEMPRE, porque o run-crm.bat usa apenas o código HTTP para
     saber que a API subiu (linha 136 do .bat);
   - o campo `database` velho continua igual, para não quebrar a checagem
     "sem-supabase" do front; o estado novo vem em `dbCheck`;
   - a tela testa a cada 5 s, então o resultado fica guardado 15 s — sem isso
     o CRM viraria um martelador do Supabase;
   - o DNS é checado em paralelo com a consulta: uma lookup desse tipo leva
     ~40 ms, enquanto o fetch do Supabase teima por ~7 s antes de devolver
     "fetch failed". Com o endereço morto, responder em 40 ms vale mais que
     esperar 5 s por um erro que já se sabia qual era;
   - nada aqui devolve URL, chave ou SQL: só o tipo do problema.
--------------------------------------------------------------------------- */

const VALIDADE_CACHE_MS = 15000;
const LIMITE_DA_CONSULTA_MS = 5000;

let ultimoChecagem = null;
let ultimoDns = null;

/* Host do banco, sem nunca sair da variável de ambiente. */
function hostDoBanco() {
  return String(process.env.SUPABASE_URL || '').replace(/^https?:\/\//, '').split('/')[0];
}

/* Verdedito do DNS, em cache por 15 s: ENOTFOUND = projeto pausado/apagado ou
   URL de outro projeto; EAI_AGAIN = DNS instável (sem rede, VPN, cabo solto). */
async function verificarDns() {
  const host = hostDoBanco();
  if (!host) return { ok: false, code: 'SEM_URL' };
  const agora = Date.now();
  if (ultimoDns && ultimoDns.host === host && agora - ultimoDns.feitaEm < VALIDADE_CACHE_MS) return ultimoDns;

  let veredito;
  try {
    await dns.lookup(host);
    veredito = { ok: true, code: '', feitaEm: agora, host };
  } catch (error) {
    veredito = { ok: false, code: String((error && error.code) || '').toUpperCase(), feitaEm: agora, host };
  }
  ultimoDns = veredito;
  return veredito;
}

function fraseDoDns(veredito) {
  if (veredito.code === 'ENOTFOUND') {
    return 'o endereço do banco não existe no DNS (ENOTFOUND). O projeto do Supabase está pausado, foi apagado, ou o SUPABASE_URL do .env é de outro projeto.';
  }
  if (veredito.code === 'EAI_AGAIN') {
    return 'o DNS não respondeu desta vez (EAI_AGAIN) — rede instável, VPN ou cabo sem conexão.';
  }
  if (veredito.code === 'SEM_URL') return 'SUPABASE_URL está vazia no .env.';
  return 'o DNS recusou o endereço do banco (' + (veredito.code || 'sem código') + ').';
}

async function consultarBanco() {
  /* 1º o DNS, que resolve (ou não) em ~40 ms. Se o endereço do banco nem
     existe, a consulta ao mesmo host não tem como dar certo — e responder na
     hora vale mais que esperar 7 s por um "fetch failed" que já se sabia qual
     era. O run-crm.bat e a tela só precisam do veredito. */
  const dnsVeredito = await verificarDns();
  if (!dnsVeredito.ok) return { ok: false, motivo: fraseDoDns(dnsVeredito) };

  const comPrazo = new Promise((resolver) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      resolver({ ok: false, motivo: `o banco não respondeu em ${LIMITE_DA_CONSULTA_MS / 1000} s` });
    }, LIMITE_DA_CONSULTA_MS);
  });

  /* select('id').limit(1) e não head:true: no head:true o PostgREST nem olha o
     schema cache, então um banco recém-criado, sem tabela nenhuma, respondia
     "ok" aqui e 502 em tudo o mais. Uma linha de id custa quase nada. */
  const consulta = supabase
    .from('leads')
    .select('id')
    .limit(1)
    .then(({ error }) => (error ? { ok: false, motivo: motivoFalhaDoBanco(error) } : { ok: true }))
    .catch((error) => ({ ok: false, motivo: motivoFalhaDoBanco(error) }));

  return Promise.race([consulta, comPrazo]);
}

async function checagemAtual() {
  if (!isConfigured || !supabase) {
    return { ok: false, motivo: 'SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY ausentes no .env' };
  }
  if (ultimoChecagem && Date.now() - ultimoChecagem.feitaEm < VALIDADE_CACHE_MS) {
    const { feitaEm, doCache: _ignorado, ...resto } = ultimoChecagem;
    return { ...resto, doCache: true };
  }
  const resultado = await consultarBanco();
  const em = new Date().toISOString();
  ultimoChecagem = { ...resultado, em, feitaEm: Date.now() };
  const { feitaEm: _feitaEm, ...publico } = ultimoChecagem;
  return { ...publico, doCache: false };
}

/* GET /api/health
   Usado pelo run-crm.bat para saber se a API subiu (espera HTTP 200).
   Nunca expõe URL, chave ou qualquer credencial: apenas booleanos/estado. */
router.get('/', async (req, res) => {
  let dbCheck;
  try {
    dbCheck = await checagemAtual();
  } catch (error) {
    /* O /health não pode cair por causa do banco: ele é justamente o pedido
       que a tela usa para descobrir que o banco caiu. */
    dbCheck = { ok: false, motivo: motivoFalhaDoBanco(error) };
  }

  res.json({
    success: true,
    status: 'ok',
    service: 'crm-backend',
    database: isConfigured ? 'configurado' : 'nao-configurado',
    dbCheck,
    time: new Date().toISOString(),
  });
});

module.exports = router;
