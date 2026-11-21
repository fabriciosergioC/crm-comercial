'use strict';

/* ===========================================================================
   Histórico das ligações (LiveKit).

   Tabela (migration 018):
     lead_calls -> uma ligação: lead, responsável, sala, status, início/fim,
                   duração e se o agente de IA foi acionado.

   Enquanto a migration não for aplicada, o histórico fica em memória e a tela
   avisa — mesma regra do histórico do WhatsApp. O link com o token NÃO é
   gravado no banco: ele vale poucas horas e fica só no processo.
   ========================================================================== */

const crypto = require('node:crypto');
const { supabase, isConfigured } = require('../../config/supabase');

const TABLE = 'lead_calls';
const DETECT_TTL_MS = 30000;

const memory = new Map();
let cache = { at: 0, mode: null, detail: '', migrationPending: false };

function missingTableError(error) {
  const code = String((error && error.code) || '');
  const msg = String((error && error.message) || '');
  return code === '42P01' || code === 'PGRST205' || /could not find the table|does not exist|relation .* does not exist/i.test(msg);
}

async function detect({ force = false } = {}) {
  if (!isConfigured || !supabase) {
    return { mode: 'memory', durable: false, migrationPending: false, detail: 'Supabase não configurado; ligações ficam em memória.' };
  }
  if (!force && cache.mode && Date.now() - cache.at < DETECT_TTL_MS) return { ...cache };
  const { error } = await supabase.from(TABLE).select('id').limit(1);
  if (!error) {
    cache = { at: Date.now(), mode: 'db', durable: true, migrationPending: false, detail: 'Ligações gravadas no Supabase.' };
    return { ...cache };
  }
  if (missingTableError(error)) {
    cache = {
      at: Date.now(), mode: 'memory', durable: false, migrationPending: true,
      detail: 'Tabela da migration 018 ainda não existe; as ligações ficam em memória até aplicá-la.',
    };
    return { ...cache };
  }
  cache = {
    at: Date.now(), mode: 'memory', durable: false, migrationPending: false,
    detail: `Não foi possível ler o histórico de ligações (${(error && error.message) || 'erro'}); usando memória.`,
  };
  return { ...cache };
}

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.lead_id,
    user: row.user || null,
    status: row.status,
    room: row.room,
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined ? null : Number(row.duration_seconds),
    expiresAt: row.expires_at || null,
    agent: Boolean(row.agent),
  };
}

function prune() {
  const limite = Date.now() - 7 * 24 * 3600 * 1000;
  for (const [id, item] of memory) {
    if (item && Date.parse(item.startedAt) < limite) memory.delete(id);
  }
}

async function create({ id, leadId, user, room, expiresAt, agent }) {
  const callId = id || crypto.randomUUID();
  const item = {
    id: callId,
    leadId,
    user: user || null,
    status: 'ativa',
    room,
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationSeconds: null,
    expiresAt: expiresAt || null,
    agent: Boolean(agent),
  };
  const storage = await detect();
  if (storage.mode === 'memory') {
    prune();
    memory.set(id, item);
    return item;
  }
  const { data, error } = await supabase.from(TABLE).insert({
    id,
    lead_id: item.leadId,
    user: item.user,
    status: item.status,
    room: item.room,
    started_at: item.startedAt,
    expires_at: item.expiresAt,
    agent: item.agent,
  }).select().single();
  if (error) {
    /* Banco fora do ar ou sem a tabela: a ligação não pode parar por causa do
       histórico. Guarda em memória e a tela mostra o aviso. */
    console.warn('[livekit] Histórico da ligação não foi gravado:', String(error.message || error).slice(0, 160));
    cache = { at: 0, mode: null, detail: '', migrationPending: false };
    memory.set(id, item);
    return item;
  }
  return fromRow(data);
}

async function get(id, leadId) {
  const storage = await detect();
  if (storage.mode === 'memory') {
    const item = memory.get(String(id));
    return item && String(item.leadId) === String(leadId) ? item : null;
  }
  const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) return null;
  const item = fromRow(data);
  return item && String(item.leadId) === String(leadId) ? item : null;
}

async function list(leadId, limit = 20) {
  const storage = await detect();
  const max = Math.min(Number(limit) || 20, 100);
  if (storage.mode === 'memory') {
    return Array.from(memory.values())
      .filter((item) => String(item.leadId) === String(leadId))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, max);
  }
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('lead_id', leadId)
    .order('started_at', { ascending: false })
    .limit(max);
  if (error) return [];
  return (data || []).map(fromRow);
}

async function end(id, { durationSeconds }) {
  const endedAt = new Date().toISOString();
  const storage = await detect();
  if (storage.mode === 'memory') {
    const item = memory.get(String(id));
    if (!item) return null;
    Object.assign(item, { status: 'encerrada', endedAt, durationSeconds });
    return item;
  }
  const { data, error } = await supabase.from(TABLE).update({
    status: 'encerrada',
    ended_at: endedAt,
    duration_seconds: durationSeconds,
  }).eq('id', id).select().single();
  if (error) return null;
  return fromRow(data);
}

async function status({ force = false } = {}) {
  return detect({ force });
}

function resetCache() {
  cache = { at: 0, mode: null, detail: '', migrationPending: false };
}

module.exports = { create, get, list, end, status, resetCache, TABLE, __memoria: memory };
