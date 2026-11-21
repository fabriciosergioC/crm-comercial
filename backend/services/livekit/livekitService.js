'use strict';

/* ===========================================================================
   LiveKit — ligações pelo navegador (WebRTC) para os leads.

   Por que sem SDK: o backend só precisa de duas coisas, um JWT HS256 assinado
   com o segredo do projeto e chamadas Twirp (HTTP/JSON) para criar/encerrar a
   sala e acionar o agente. Node resolve as duas com `crypto` e `fetch`, então
   não entra dependência nova no CRM.

   Minutos gratuitos do LiveKit Cloud cobrem as ligações pelo navegador e as
   ligações atendidas pelo agente (STT/LLM/TTS na nuvem). Ligação para telefone
   de verdade (PSTN) NÃO está incluída no plano gratuito: precisa de um trunk
   SIP/telefonia à parte.

   Nenhum segredo sai daqui: status() devolve só host e booleanos.
   ========================================================================== */

const crypto = require('node:crypto');
const config = require('../ai/aiConfig').livekit;

const HTTP_TIMEOUT_MS = 10000;
const TWIRP_TIMEOUT_MS = 12000;

let adminCache = { token: '', exp: 0 };

function configured() {
  return Boolean(config.url && config.apiKey && config.apiSecret);
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function httpBase() {
  const raw = normalizeUrl(config.url);
  return raw.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
}

function wsUrl() {
  const raw = normalizeUrl(config.url);
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, 'wss://').replace(/^https:\/\//i, 'wss://');
  if (/^wss?:\/\//i.test(raw)) return raw;
  return `wss://${raw}`;
}

/* Só o host: a chave e o segredo nunca aparecem em tela nem em log. */
function urlHost() {
  try {
    return new URL(wsUrl()).host;
  } catch (_) {
    return '';
  }
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

/* JWT HS256 do LiveKit: `iat` não é exigido; `nbf` evita relógio adiantado. */
function signJwt(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', config.apiSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/* Token de administração para as chamadas de servidor (criar sala, acionar
   agente, encerrar sala). Vale pouco tempo e é reaproveitado. */
function adminToken() {
  if (!configured()) throw new Error('LiveKit não configurado (LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET).');
  const agora = nowSeconds();
  if (adminCache.token && adminCache.exp - 60 > agora) return adminCache.token;
  const exp = agora + 300;
  const token = signJwt({
    iss: config.apiKey,
    sub: config.apiKey,
    nbf: agora - 10,
    exp,
    video: { roomCreate: true, roomList: true, roomAdmin: true },
  });
  adminCache = { token, exp };
  return token;
}

/* Token de entrada na sala. `identity` precisa ser única por participante. */
function joinToken({ room, identity, name, metadata, ttlSeconds }) {
  if (!configured()) throw new Error('LiveKit não configurado.');
  if (!room || !identity) throw new Error('Sala e identidade são obrigatórias para o token.');
  const agora = nowSeconds();
  const ttl = Math.max(60, Math.min(Number(ttlSeconds) || config.tokenTtlMinutes * 60, 24 * 3600));
  return signJwt({
    iss: config.apiKey,
    sub: identity,
    nbf: agora - 10,
    exp: agora + ttl,
    name: name || identity,
    metadata: metadata ? JSON.stringify(metadata) : undefined,
    video: {
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  });
}

/* O AgentDispatch só aceita token com a sala no grant. O token global
   (adminToken) serve para criar/listar/encerrar salas, mas recebe
   "permissions denied" ao acionar o agente. */
function roomAdminToken(room) {
  const agora = nowSeconds();
  return signJwt({
    iss: config.apiKey,
    sub: config.apiKey,
    nbf: agora - 10,
    exp: agora + 300,
    video: { room, roomAdmin: true, roomCreate: true, roomList: true },
  });
}

async function twirp(service, method, body, token) {
  const res = await fetch(`${httpBase()}/twirp/livekit.${service}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token || adminToken()}`,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(TWIRP_TIMEOUT_MS),
  });
  const texto = await res.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch (_) { dados = null; }
  if (!res.ok) {
    const detalhe = (dados && (dados.message || dados.msg || dados.error)) || `HTTP ${res.status}`;
    const erro = new Error(`LiveKit ${service}/${method}: ${String(detalhe).slice(0, 300)}`);
    erro.status = res.status;
    erro.code = dados && dados.code;
    throw erro;
  }
  return dados || {};
}

/* Cria a sala antes de alguém entrar. Sala já existente não é erro: o lead
   pode reabrir o link da mesma ligação. */
async function ensureRoom(room, { metadata, emptyTimeout = 600, departureTimeout = 300 } = {}) {
  try {
    return await twirp('RoomService', 'CreateRoom', {
      name: room,
      empty_timeout: emptyTimeout,
      departure_timeout: departureTimeout,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
    });
  } catch (error) {
    const jaExiste = error.status === 409 || /already exists|já existe/i.test(String(error.message || ''));
    if (jaExiste) return { name: room, existed: true };
    throw error;
  }
}

async function deleteRoom(room) {
  try {
    await twirp('RoomService', 'DeleteRoom', { room });
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

/* Aciona o agente de IA do LiveKit Cloud na sala, quando configurado.
   A falha aqui nunca derruba a ligação: o atendente e o lead continuam
   conversando pelo navegador mesmo sem agente. */
async function dispatchAgent(room, metadata) {
  if (!config.agentName) {
    return { dispatched: false, detail: 'Agente de IA não configurado (LIVEKIT_AGENT_NAME vazio).' };
  }
  try {
    const dados = await twirp('AgentDispatchService', 'CreateDispatch', {
      room,
      agent_name: config.agentName,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
    }, roomAdminToken(room));
    return { dispatched: true, id: (dados && dados.id) || '', detail: 'Agente acionado na sala.' };
  } catch (error) {
    return { dispatched: false, detail: `Agente não acionado: ${String((error && error.message) || error).slice(0, 200)}` };
  }
}

function status() {
  const pronto = configured();
  return {
    configured: pronto,
    urlHost: pronto ? urlHost() : '',
    agent: Boolean(config.agentName),
    tokenTtlMinutes: config.tokenTtlMinutes,
    detail: pronto
      ? `LiveKit pronto${config.agentName ? ' (agente de IA configurado)' : ' (ligação entre navegadores)'}.`
      : 'LiveKit não configurado. Preencha LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET no backend/.env.',
  };
}

function wssUrl() {
  return wsUrl();
}

function resetCache() {
  adminCache = { token: '', exp: 0 };
}

module.exports = {
  configured,
  status,
  wsUrl: wssUrl,
  urlHost,
  joinToken,
  ensureRoom,
  deleteRoom,
  dispatchAgent,
  resetCache,
};
