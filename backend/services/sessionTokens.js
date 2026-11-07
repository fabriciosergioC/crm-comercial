const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/* ===========================================================================
   Sessão assinada do CRM (sem dependência nova: só o crypto do Node).
   -------------------------------------------------------------------------
   Por que isto existe: quando o CRM fica acessível pela internet (túnel ngrok),
   qualquer pessoa que descobrir o endereço podia chamar /api/leads direto e
   receber todos os clientes, sem senha nenhuma — a tela de login é só o
   frontend, ela não fecha o backend.

   Como funciona: no login certo o backend emite um token assinado (HMAC-SHA256)
   contendo { usuário, expiração }. O navegador guarda isso em cookie httpOnly e
   envia sozinho em toda chamada; o middleware sessionGate confere a assinatura e
   a validade. Sem token válido = 401 com a mensagem em português.

   O segredo de assinatura vem de SESSION_SECRET no backend\.env; se não houver,
   ele é gerado uma vez e guardado em backend\data\session-secret.key (o arquivo
   nunca vai para o GitHub — está no .gitignore). Assim os logins não são
   derrubados a cada reinicialização, mas o segredo continua só na máquina dele.
   ========================================================================= */

const COOKIE_NAME = 'crm_session';
const HEADER_NAME = 'x-crm-session';
const SECRET_FILE = path.join(__dirname, '..', 'data', 'session-secret.key');

function ttlHours() {
  const n = Number(process.env.SESSION_TTL_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 168; // padrão: 7 dias
}

let cachedSecret = null;
let ephemeralSecret = null;

function getSecret() {
  if (cachedSecret) return cachedSecret;
  const fromEnv = typeof process.env.SESSION_SECRET === 'string' ? process.env.SESSION_SECRET.trim() : '';
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const saved = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (saved.length >= 32) {
        cachedSecret = saved;
        return cachedSecret;
      }
    }
  } catch (error) {
    /* arquivo ilegível: cai no segredo temporário, que expira ao desligar */
  }
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, fresh, { encoding: 'utf8', flag: 'wx' });
    cachedSecret = fresh;
  } catch (error) {
    /* sem permissão de escrita (ou corrida de criação): usa só em memória */
    ephemeralSecret = ephemeralSecret && ephemeralSecret.length ? ephemeralSecret : fresh;
    cachedSecret = ephemeralSecret;
  }
  return cachedSecret;
}

function toBase64Url(text) {
  return Buffer.from(String(text), 'utf8').toString('base64url');
}

function fromBase64Url(value) {
  try {
    return Buffer.from(String(value), 'base64url').toString('utf8');
  } catch (error) {
    return '';
  }
}

function signature(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

/* Assina a sessão do usuário. O nome vem dentro do payload, então um token não
   serve para outro usuário: a assinatura cobre o conteúdo inteiro. */
function signSession(userId, hours = ttlHours()) {
  const id = String(userId || '');
  if (!id) return null;
  const expiresAt = Date.now() + Math.round(hours * 3600 * 1000);
  const payload = toBase64Url(JSON.stringify({ u: id, e: expiresAt }));
  return `${payload}.${signature(payload)}`;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/* Token → { userId, expiresAt }. Null quando adulterado, vencido ou malformado. */
function verifySession(token) {
  const raw = String(token || '').trim();
  if (!raw || raw.length > 4096) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 1 || dot === raw.length - 1) return null;
  const payload = raw.slice(0, dot);
  const given = raw.slice(dot + 1);
  if (!safeEqual(given, signature(payload))) return null;
  let body = null;
  try {
    body = JSON.parse(fromBase64Url(payload));
  } catch (error) {
    return null;
  }
  const userId = body && typeof body.u === 'string' ? body.u : '';
  const expiresAt = body && Number(body.e);
  if (!userId || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= Date.now()) return null;
  return { userId, expiresAt };
}

/* túnel https? ngrok manda X-Forwarded-Proto; direto no notebook é http puro. */
function isSecureRequest(req) {
  const proto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (proto) return proto === 'https';
  return Boolean(req.secure);
}

/* Grava (token) ou limpa (null) o cookie de sessão. httpOnly é o ponto: o
   JavaScript da página não consegue ler o token, então ele não vaza por XSS. */
function applySessionCookie(req, res, token) {
  const maxAgeSeconds = token ? Math.max(0, Math.round(ttlHours() * 3600)) : 0;
  const parts = [
    `${COOKIE_NAME}=${token ? encodeURIComponent(token) : ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  parts.push(token ? `Max-Age=${maxAgeSeconds}` : 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  const existing = res.getHeader('Set-Cookie');
  const line = parts.join('; ');
  res.setHeader('Set-Cookie', Array.isArray(existing) ? existing.concat(line) : [line]);
}

function readCookieValue(req) {
  const header = String(req.headers.cookie || '');
  if (!header) return '';
  for (const piece of header.split(';')) {
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    if (piece.slice(0, eq).trim() !== COOKIE_NAME) continue;
    try {
      return decodeURIComponent(piece.slice(eq + 1).trim());
    } catch (error) {
      return piece.slice(eq + 1).trim();
    }
  }
  return '';
}

/* Cookie (mesma origem, automático) ou cabeçalho (fallback para quando o
   navegador bloqueia cookie ou a página é aberta de fora do backend). */
function readSessionToken(req) {
  return readCookieValue(req) || String(req.get(HEADER_NAME) || '').trim();
}

module.exports = {
  COOKIE_NAME,
  HEADER_NAME,
  ttlHours,
  signSession,
  verifySession,
  applySessionCookie,
  readSessionToken,
  isSecureRequest,
};
