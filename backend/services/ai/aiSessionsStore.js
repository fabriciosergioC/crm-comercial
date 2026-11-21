'use strict';

/* ===========================================================================
   Persistência das sessões de atendimento por IA.

   Tabelas (migration 016):
     lead_ai_sessions  -> uma sessão (lead, responsável, início/fim, duração,
                          transcrição consolidada, status)
     lead_ai_messages  -> cada mensagem (assistente/usuário), em ordem

   A migration é idempotente e não toca em nenhuma tabela existente. Enquanto
   ela não for aplicada no Supabase, o armazenamento cai para memória do
   processo — a conversa continua funcionando e a tela avisa, em vez de fingir
   que gravou. Assim que as tabelas existirem, o modo "auto" passa a gravar no
   banco sem reiniciar o backend (a checagem é refeita a cada 30 s).
   ========================================================================== */

const crypto = require('node:crypto');
const { supabase, isConfigured } = require('../../config/supabase');
const { ApiError } = require('../../middleware/errorHandler');
const config = require('./aiConfig');

const SESSIONS_TABLE = 'lead_ai_sessions';
const MESSAGES_TABLE = 'lead_ai_messages';
const DETECT_TTL_MS = 30000;

const memory = {
  sessions: new Map(),
  messages: new Map(),
  order: [],
};

let storageCache = { at: 0, mode: null, detail: '', migrationPending: false };

function missingTableError(error) {
  const code = String((error && error.code) || '');
  const msg = String((error && error.message) || '');
  return code === '42P01' || code === 'PGRST205' || /could not find the table|does not exist|relation .* does not exist/i.test(msg);
}

function dbFailure(action, error) {
  return new ApiError(502, `Não foi possível ${action} no banco (${(error && error.message) || 'erro desconhecido'}).`);
}

async function detectStorage({ force = false } = {}) {
  const forced = config.storage.mode;
  if (forced === 'memory') {
    return { mode: 'memory', durable: false, migrationPending: false, detail: 'Armazenamento em memória forçado (AI_STORAGE=memory).' };
  }
  if (!isConfigured || !supabase) {
    return { mode: 'memory', durable: false, migrationPending: false, detail: 'Supabase não configurado; histórico fica em memória.' };
  }
  if (!force && storageCache.mode && Date.now() - storageCache.at < DETECT_TTL_MS) {
    return { ...storageCache };
  }

  const { error } = await supabase.from(SESSIONS_TABLE).select('id').limit(1);
  if (!error) {
    storageCache = { at: Date.now(), mode: 'db', durable: true, migrationPending: false, detail: 'Histórico gravado no Supabase.' };
    return { ...storageCache };
  }

  if (missingTableError(error)) {
    const detail = 'Tabelas da migration 016 ainda não existem; o histórico fica em memória até aplicá-la.';
    storageCache = { at: Date.now(), mode: 'memory', durable: false, migrationPending: true, detail };
    if (forced === 'db') throw new ApiError(503, detail);
    return { ...storageCache };
  }

  const detail = `Não foi possível ler as tabelas de histórico da IA (${(error && error.message) || 'erro'}); usando memória.`;
  storageCache = { at: Date.now(), mode: 'memory', durable: false, migrationPending: false, detail };
  if (forced === 'db') throw new ApiError(502, detail);
  return { ...storageCache };
}

function sessionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.lead_id,
    user: row.user || null,
    status: row.status,
    channel: row.channel || 'voz',
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined ? null : Number(row.duration_seconds),
    transcript: row.transcript || '',
    messageCount: Number(row.message_count || 0),
  };
}

function messageFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

function pruneMemory() {
  const max = config.storage.memorySessions;
  while (memory.order.length > max) {
    const oldest = memory.order.shift();
    memory.sessions.delete(oldest);
    memory.messages.delete(oldest);
  }
}

function memoryCreateSession(session) {
  memory.sessions.set(session.id, {
    id: session.id,
    leadId: session.leadId,
    user: session.user || null,
    status: 'ativa',
    channel: session.channel || 'voz',
    startedAt: session.startedAt,
    endedAt: null,
    durationSeconds: null,
    transcript: '',
    messageCount: 0,
  });
  memory.messages.set(session.id, []);
  memory.order.push(session.id);
  pruneMemory();
}

async function createSession({ id, leadId, user, channel = 'voz' }) {
  const storage = await detectStorage();
  const startedAt = new Date().toISOString();
  if (storage.mode === 'memory') {
    memoryCreateSession({ id, leadId, user, startedAt, channel });
    return getSession(id);
  }
  const linha = { id, lead_id: leadId, user: user || null, status: 'ativa', started_at: startedAt, channel };
  let { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .insert(linha)
    .select()
    .single();
  /* Banco sem a coluna channel (migration 017 pendente): a sessão continua
     valendo, só não distingue voz de WhatsApp no histórico. */
  if (error && error.code === '42703') {
    delete linha.channel;
    ({ data, error } = await supabase.from(SESSIONS_TABLE).insert(linha).select().single());
  }
  if (error) {
    if (missingTableError(error)) {
      storageCache = { at: 0, mode: null, detail: '', migrationPending: false };
      memoryCreateSession({ id, leadId, user, startedAt, channel });
      return getSession(id);
    }
    throw dbFailure('criar a sessão de atendimento', error);
  }
  return sessionFromRow(data);
}

async function getSession(id) {
  const storage = await detectStorage();
  if (storage.mode === 'memory') return memory.sessions.get(id) || null;
  const { data, error } = await supabase.from(SESSIONS_TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw dbFailure('consultar a sessão de atendimento', error);
  return sessionFromRow(data);
}

async function getSessionForLead(id, leadId) {
  const session = await getSession(id);
  if (!session) return null;
  if (String(session.leadId) !== String(leadId)) return null;
  return session;
}

async function listSessions(leadId, limit) {
  const storage = await detectStorage();
  const max = Math.min(Number(limit) || config.storage.sessionsPerLead, 100);
  if (storage.mode === 'memory') {
    return memory.order
      .map((id) => memory.sessions.get(id))
      .filter((s) => s && (!leadId || String(s.leadId) === String(leadId)))
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
      .slice(0, max);
  }
  let q = supabase.from(SESSIONS_TABLE).select('*').order('started_at', { ascending: false }).limit(max);
  if (leadId) q = q.eq('lead_id', leadId);
  const { data, error } = await q;
  if (error) {
    if (missingTableError(error)) {
      storageCache = { at: 0, mode: null, detail: '', migrationPending: false };
      return listSessions(leadId, limit);
    }
    throw dbFailure('listar as sessões de atendimento', error);
  }
  return (data || []).map(sessionFromRow);
}

async function addMessage(sessionId, { role, content }) {
  const storage = await detectStorage();
  const message = {
    id: `aim_${crypto.randomUUID()}`,
    sessionId,
    role,
    content,
    createdAt: new Date().toISOString(),
  };
  if (storage.mode === 'memory') {
    const list = memory.messages.get(sessionId) || [];
    list.push(message);
    memory.messages.set(sessionId, list);
    const session = memory.sessions.get(sessionId);
    if (session) session.messageCount = list.length;
    return message;
  }
  const { data, error } = await supabase
    .from(MESSAGES_TABLE)
    .insert({ id: message.id, session_id: sessionId, role, content })
    .select()
    .single();
  if (error) {
    if (missingTableError(error)) {
      storageCache = { at: 0, mode: null, detail: '', migrationPending: false };
      return addMessage(sessionId, { role, content });
    }
    throw dbFailure('gravar a mensagem do atendimento', error);
  }
  return messageFromRow(data);
}

async function listMessages(sessionId) {
  const storage = await detectStorage();
  if (storage.mode === 'memory') return [...(memory.messages.get(sessionId) || [])];
  const { data, error } = await supabase
    .from(MESSAGES_TABLE)
    .select('*')
    .eq('session_id', sessionId)
    .order('seq', { ascending: true });
  if (error) throw dbFailure('consultar as mensagens do atendimento', error);
  return (data || []).map(messageFromRow);
}

async function updateSession(sessionId, patch) {
  const storage = await detectStorage();
  if (storage.mode === 'memory') {
    const session = memory.sessions.get(sessionId);
    if (!session) return null;
    Object.assign(session, patch);
    return session;
  }
  const row = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.endedAt !== undefined) row.ended_at = patch.endedAt;
  if (patch.durationSeconds !== undefined) row.duration_seconds = patch.durationSeconds;
  if (patch.transcript !== undefined) row.transcript = patch.transcript;
  if (patch.messageCount !== undefined) row.message_count = patch.messageCount;
  const { data, error } = await supabase.from(SESSIONS_TABLE).update(row).eq('id', sessionId).select().single();
  if (error) throw dbFailure('atualizar a sessão de atendimento', error);
  return sessionFromRow(data);
}

async function endSession(sessionId, { status, transcript, messageCount, durationSeconds, endedAt }) {
  return updateSession(sessionId, {
    status,
    transcript,
    messageCount,
    durationSeconds,
    endedAt: endedAt || new Date().toISOString(),
  });
}

async function storageStatus({ force = false } = {}) {
  return detectStorage({ force });
}

function resetStorageCache() {
  storageCache = { at: 0, mode: null, detail: '', migrationPending: false };
}

module.exports = {
  createSession,
  getSession,
  getSessionForLead,
  listSessions,
  addMessage,
  listMessages,
  updateSession,
  endSession,
  storageStatus,
  resetStorageCache,
  SESSIONS_TABLE,
  MESSAGES_TABLE,
};
