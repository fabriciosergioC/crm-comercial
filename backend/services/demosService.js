const { supabase, isConfigured } = require('../config/supabase');
const { ApiError } = require('../middleware/errorHandler');
const { buildMapper, parseFilters, parseLimit, mapDbError, newId } = require('./modelHelpers');

/* Demos (tabela lead_demos) — prévias enviadas ao cliente, com validade
   (padrão 24h, igual ao front-end).

   SEM delete: a demo é desativada (deactivated = true). */

const COLUMNS = {
  id: 'id',
  leadId: 'lead_id',
  url: 'url',
  createdAt: 'created_at',
  sentAt: 'sent_at',
  validityHours: 'validity_hours',
  expiresAt: 'expires_at',
  owner: 'owner',
  deactivated: 'deactivated',
  views: 'views',
  lastViewedAt: 'last_viewed_at',
  updatedAt: 'updated_at',
};

const { toRow, fromRow } = buildMapper(COLUMNS);
const FILTERS = ['leadId', 'owner', 'deactivated'];

function assertReady() {
  if (!isConfigured || !supabase) {
    throw new ApiError(503, 'Supabase não configurado — defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do backend.');
  }
}

async function list(query) {
  assertReady();
  let q = supabase
    .from('lead_demos')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(parseLimit(query));

  for (const [column, value] of parseFilters(query, COLUMNS, FILTERS)) {
    q = q.eq(column, value);
  }

  const { data, error } = await q;
  if (error) throw mapDbError(error, 'Falha ao consultar as demos.');
  return (data || []).map(fromRow);
}

async function getById(id) {
  assertReady();
  const { data, error } = await supabase.from('lead_demos').select('*').eq('id', id).maybeSingle();
  if (error) throw mapDbError(error, 'Falha ao consultar a demo.');
  if (!data) throw new ApiError(404, 'Demo não encontrada.');
  return fromRow(data);
}

/* payload validado na rota: { leadId, url, validityHours?, owner?, sentAt? }.
   Se `sentAt` vier (enviada na hora), a expiração já é calculada aqui. */
async function create(payload) {
  assertReady();
  const row = toRow(payload);
  if (!row.id) row.id = newId('d');
  if (!row.validity_hours) row.validity_hours = 24;
  if (row.sent_at && !row.expires_at) {
    row.expires_at = new Date(new Date(row.sent_at).getTime() + row.validity_hours * 3600000).toISOString();
  }
  const { data, error } = await supabase.from('lead_demos').insert(row).select().single();
  if (error) throw mapDbError(error, 'Falha ao criar a demo.');
  return fromRow(data);
}

/* PATCH: { url?, validityHours?, sentAt?, expiresAt?, deactivated?, views?,
            lastViewedAt? }
   Marcar como enviada (sentAt) sem informar expiresAt calcula a expiração
   pelo prazo de validade — uma chamada só, como o front precisa. */
async function update(id, patch) {
  assertReady();
  const current = await getById(id); // 404 se não existir
  const row = toRow(patch);
  delete row.id;
  delete row.lead_id;

  if (row.sent_at && !row.expires_at) {
    const hours = row.validity_hours || current.validityHours || 24;
    row.expires_at = new Date(new Date(row.sent_at).getTime() + hours * 3600000).toISOString();
  }

  if (Object.keys(row).length === 0) return current;
  const { data, error } = await supabase.from('lead_demos').update(row).eq('id', id).select().single();
  if (error) throw mapDbError(error, 'Falha ao atualizar a demo.');
  return fromRow(data);
}

module.exports = { list, getById, create, update, COLUMNS, FILTERS };