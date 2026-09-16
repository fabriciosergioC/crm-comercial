const { supabase, isConfigured } = require('../config/supabase');
const { ApiError } = require('../middleware/errorHandler');
const { buildMapper, parseFilters, parseLimit, mapDbError, newId } = require('./modelHelpers');

/* Clientes (tabela clients) — leads convertidos. Relação 1:1 com o lead
   (coluna lead_id é UNIQUE), igual ao front-end faz
   (db.clients.find(c => c.leadId === leadId)).

   SEM delete: o cliente muda de situação pelo campo status.
   O banco aceita qualquer status aqui de propósito; a aplicação usa "Ativo". */

const COLUMNS = {
  id: 'id',
  leadId: 'lead_id',
  company: 'company',
  contactName: 'contact_name',
  plan: 'plan',
  contractedValue: 'contracted_value',
  monthlyValue: 'monthly_value',
  closingDate: 'closing_date',
  publishDate: 'publish_date',
  domain: 'domain',
  owner: 'owner',
  notes: 'notes',
  status: 'status',
  createdAt: 'created_at',
};

const { toRow, fromRow } = buildMapper(COLUMNS);
const FILTERS = ['leadId', 'owner', 'status'];

function assertReady() {
  if (!isConfigured || !supabase) {
    throw new ApiError(503, 'Supabase não configurado — defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do backend.');
  }
}

async function list(query) {
  assertReady();
  let q = supabase
    .from('clients')
    .select('*')
    .order('closing_date', { ascending: false, nullsFirst: false })
    .limit(parseLimit(query));

  for (const [column, value] of parseFilters(query, COLUMNS, FILTERS)) {
    q = q.eq(column, value);
  }

  const { data, error } = await q;
  if (error) throw mapDbError(error, 'Falha ao consultar os clientes.');
  return (data || []).map(fromRow);
}

async function getById(id) {
  assertReady();
  const { data, error } = await supabase.from('clients').select('*').eq('id', id).maybeSingle();
  if (error) throw mapDbError(error, 'Falha ao consultar o cliente.');
  if (!data) throw new ApiError(404, 'Cliente não encontrado.');
  return fromRow(data);
}

/* Conversão de lead em cliente (mesmo fluxo do front-end):
   { leadId, company, contactName, plan, contractedValue?, monthlyValue?,
     closingDate?, publishDate?, domain?, owner?, notes?, status? }
   Não altera o status do lead — o front-end também não altera nesse passo. */
async function create(payload) {
  assertReady();
  const row = toRow(payload);
  if (!row.id) row.id = newId('c');
  if (!row.status) row.status = 'Ativo';
  if (!row.closing_date) row.closing_date = new Date().toISOString();
  const { data, error } = await supabase.from('clients').insert(row).select().single();
  if (error) throw mapDbError(error, 'Falha ao registrar o cliente.');
  return fromRow(data);
}

/* PATCH: { company?, contactName?, plan?, contractedValue?, monthlyValue?,
            publishDate?, domain?, owner?, notes?, status? } */
async function update(id, patch) {
  assertReady();
  await getById(id); // 404 se não existir
  const row = toRow(patch);
  delete row.id;
  delete row.lead_id;
  if (Object.keys(row).length === 0) return getById(id);
  const { data, error } = await supabase.from('clients').update(row).eq('id', id).select().single();
  if (error) throw mapDbError(error, 'Falha ao atualizar o cliente.');
  return fromRow(data);
}

module.exports = { list, getById, create, update, COLUMNS, FILTERS };