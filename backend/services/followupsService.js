const { supabase, isConfigured } = require('../config/supabase');
const { ApiError } = require('../middleware/errorHandler');
const { buildMapper, parseFilters, parseLimit, mapDbError, newId } = require('./modelHelpers');

/* Follow-ups (tabela lead_followups).

   SEM delete: o front-end conclui (status "concluido"), reagenda (nova due_date)
   ou cancela (status "cancelado"). Nada é apagado — igual ao comportamento
   atual da aplicação. */

const COLUMNS = {
  id: 'id',
  leadId: 'lead_id',
  dueDate: 'due_date',
  note: 'note',
  status: 'status',
  createdBy: 'created_by',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const { toRow, fromRow } = buildMapper(COLUMNS);
const FILTERS = ['leadId', 'status', 'createdBy'];

function assertReady() {
  if (!isConfigured || !supabase) {
    throw new ApiError(503, 'Supabase não configurado — defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do backend.');
  }
}

/* list({ leadId?, status?, createdBy?, limit? }) - por vencimento. */
async function list(query) {
  assertReady();
  let q = supabase
    .from('lead_followups')
    .select('*')
    .order('due_date', { ascending: true })
    .limit(parseLimit(query));

  for (const [column, value] of parseFilters(query, COLUMNS, FILTERS)) {
    q = q.eq(column, value);
  }

  const { data, error } = await q;
  if (error) throw mapDbError(error, 'Falha ao consultar os follow-ups.');
  return (data || []).map(fromRow);
}

async function getById(id) {
  assertReady();
  const { data, error } = await supabase.from('lead_followups').select('*').eq('id', id).maybeSingle();
  if (error) throw mapDbError(error, 'Falha ao consultar o follow-up.');
  if (!data) throw new ApiError(404, 'Follow-up não encontrado.');
  return fromRow(data);
}

/* payload já validado na rota: { leadId, dueDate?, note?, status?, createdBy? } */
async function create(payload) {
  assertReady();
  const row = toRow(payload);
  if (!row.id) row.id = newId('f');
  if (!row.status) row.status = 'pendente';
  const { data, error } = await supabase.from('lead_followups').insert(row).select().single();
  if (error) throw mapDbError(error, 'Falha ao criar o follow-up.');
  return fromRow(data);
}

/* patch validado na rota: { dueDate?, note?, status? } */
async function update(id, patch) {
  assertReady();
  await getById(id); // 404 se não existir
  const row = toRow(patch);
  delete row.id;
  delete row.lead_id;
  if (Object.keys(row).length === 0) return getById(id);
  const { data, error } = await supabase.from('lead_followups').update(row).eq('id', id).select().single();
  if (error) throw mapDbError(error, 'Falha ao atualizar o follow-up.');
  return fromRow(data);
}

module.exports = { list, getById, create, update, COLUMNS, FILTERS };