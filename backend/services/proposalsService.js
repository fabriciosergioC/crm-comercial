const { supabase, isConfigured } = require('../config/supabase');
const { ApiError } = require('../middleware/errorHandler');
const { buildMapper, parseFilters, parseLimit, mapDbError, newId } = require('./modelHelpers');

/* Propostas (tabela lead_proposals).

   SEM delete: a proposta muda de status (Enviada / Em negociação / Aprovada /
   Recusada) — nada é apagado. */

const COLUMNS = {
  id: 'id',
  leadId: 'lead_id',
  plan: 'plan',
  implementationValue: 'implementation_value',
  monthlyValue: 'monthly_value',
  proposalDate: 'proposal_date',
  validUntil: 'valid_until',
  notes: 'notes',
  status: 'status',
  createdAt: 'created_at',
};

const { toRow, fromRow } = buildMapper(COLUMNS);
const FILTERS = ['leadId', 'status'];

function assertReady() {
  if (!isConfigured || !supabase) {
    throw new ApiError(503, 'Supabase não configurado — defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do backend.');
  }
}

async function list(query) {
  assertReady();
  let q = supabase
    .from('lead_proposals')
    .select('*')
    .order('proposal_date', { ascending: false })
    .limit(parseLimit(query));

  for (const [column, value] of parseFilters(query, COLUMNS, FILTERS)) {
    q = q.eq(column, value);
  }

  const { data, error } = await q;
  if (error) throw mapDbError(error, 'Falha ao consultar as propostas.');
  return (data || []).map(fromRow);
}

async function getById(id) {
  assertReady();
  const { data, error } = await supabase.from('lead_proposals').select('*').eq('id', id).maybeSingle();
  if (error) throw mapDbError(error, 'Falha ao consultar a proposta.');
  if (!data) throw new ApiError(404, 'Proposta não encontrada.');
  return fromRow(data);
}

/* payload validado na rota:
   { leadId, plan, implementationValue?, monthlyValue?, proposalDate?,
     validUntil?, notes?, status? } */
async function create(payload) {
  assertReady();
  const row = toRow(payload);
  if (!row.id) row.id = newId('p');
  if (!row.status) row.status = 'Enviada';
  const { data, error } = await supabase.from('lead_proposals').insert(row).select().single();
  if (error) throw mapDbError(error, 'Falha ao criar a proposta.');
  return fromRow(data);
}

/* PATCH: { plan?, implementationValue?, monthlyValue?, validUntil?, notes?,
            status? } */
async function update(id, patch) {
  assertReady();
  await getById(id); // 404 se não existir
  const row = toRow(patch);
  delete row.id;
  delete row.lead_id;
  if (Object.keys(row).length === 0) return getById(id);
  const { data, error } = await supabase.from('lead_proposals').update(row).eq('id', id).select().single();
  if (error) throw mapDbError(error, 'Falha ao atualizar a proposta.');
  return fromRow(data);
}

module.exports = { list, getById, create, update, COLUMNS, FILTERS };