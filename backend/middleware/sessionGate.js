const { verifySession, readSessionToken } = require('../services/sessionTokens');

/* ===========================================================================
   Portão de sessão do backend.
   -------------------------------------------------------------------------
   O que ele fecha: os endpoints de DADOS (/leads, /whatsapp, /enrichment e
   companhia). É neles que estão os clientes, os telefones e as conversas — sem
   este portão, quem descobrisse o endereço público do túnel ngrok podia pedir
   /api/leads e baixar tudo sem digitar senha nenhuma.

   O que ele deixa passar SEMPRE:
     - /health  (o run-crm.bat usa isso para saber se a API subiu)
     - /auth/login, /auth/status, /auth/logout (é pelo login que se obtém a sessão)
     - arquivos do site (index.html, css, js, ícones) — a tela de entrada precisa
       carregar antes de qualquer login.

   O que ele deixa passar quando o pedido vem do PRÓPRIO notebook: Host localhost
   ou 127.0.0.1, sem X-Forwarded-*. Assim você nunca fica trancado fora do seu
   próprio sistema, nem se o token expirar, e o run-crm.bat continua funcionando
   exatamente como antes. pela internet (Host xxx.ngrok.app) o token é obrigatório.

   O token chega em cookie httpOnly (o navegador manda sozinho) ou no cabeçalho
   x-crm-session (para quando a página é aberta fora do backend).
   ========================================================================= */

/* Prefixos de rota que carregam dados de clientes. Qualquer outro nome cai fora
   do portão (health, auth, arquivos estáticos). */
const GUARDED_PREFIXES = [
  'leads',
  'status-history',
  'interactions',
  'followups',
  'agenda',
  'demos',
  'proposals',
  'clients',
  'client-updates',
  'enrichment',
  'whatsapp',
  'finance',
];

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];

function hostName(req) {
  const host = String(req.headers.host || '');
  const withoutPort = host.replace(/\]:\d+$/, '').replace(/:\d+$/, '');
  return withoutPort.toLowerCase();
}

/* Pedido local = Host de loopback E sem rastro de proxy. Importante: o ngrok roda
   como processo na máquina dele, então um pedido da internet chega com IP de
   origem 127.0.0.1 — quem denuncia o túnel é o Host / X-Forwarded-For, nunca o IP. */
function isLocalAccess(req) {
  if (req.get('x-forwarded-host') || req.get('x-forwarded-for')) return false;
  return LOCAL_HOSTS.includes(hostName(req));
}

/* Nome do recurso dentro do router: o routes/index.js está montado em /api e em
   /, então req.url é relativo ao ponto de montagem nos dois casos. */
function resourceName(req) {
  const raw = String(req.url || req.path || '/').split('?')[0];
  const first = raw.split('/').filter(Boolean)[0] || '';
  return first.toLowerCase();
}

function isGuarded(req) {
  return GUARDED_PREFIXES.includes(resourceName(req));
}

function unauthorized(res) {
  res.status(401).json({
    success: false,
    sessionExpired: true,
    message: 'Faça login para ver os dados do CRM. Sua sessão expirou ou este navegador ainda não entrou.',
  });
}

function sessionGate(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (!isGuarded(req)) return next();
  if (isLocalAccess(req)) {
    req.crmLocal = true;
    return next();
  }
  const token = readSessionToken(req);
  const session = token ? verifySession(token) : null;
  if (!session) return unauthorized(res);
  req.crmSession = session;
  return next();
}

/* Usado pela rota de login e pelo /auth/status: diz se o pedido veio do notebook
   (só lá a senha padrão pode aparecer na resposta). */
function requestIsLocal(req) {
  return isLocalAccess(req);
}

module.exports = { sessionGate, isGuarded, isLocalAccess, requestIsLocal, GUARDED_PREFIXES };
