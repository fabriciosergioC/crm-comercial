const { supabase, isConfigured } = require('../config/supabase');
const { ApiError } = require('../middleware/errorHandler');
const { buildMapper, parseFilters, parseLimit, mapDbError, newId } = require('./modelHelpers');

const COLUMNS = {
  id: 'id',
  type: 'type',
  title: 'title',
  eventAt: 'event_at',
  leadId: 'lead_id',
  owner: 'owner',
  notes: 'notes',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const { toRow, fromRow } = buildMapper(COLUMNS);
const FILTERS = ['type', 'leadId', 'owner', 'status'];

function assertReady() {
  if (!isConfigured || !supabase) {
    throw new ApiError(503, 'Supabase não configurado — defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do backend.');
  }
}

async function list(query) {
  assertReady();
  let request = supabase
    .from('agenda_events')
    .select('*')
    .order('event_at', { ascending: true })
    .limit(parseLimit(query));

  for (const [column, value] of parseFilters(query, COLUMNS, FILTERS)) {
    request = request.eq(column, value);
  }

  const { data, error } = await request;
  if (error) throw mapDbError(error, 'Falha ao consultar os eventos da agenda.');
  return (data || []).map(fromRow);
}

async function getById(id) {
  assertReady();
  const { data, error } = await supabase.from('agenda_events').select('*').eq('id', id).maybeSingle();
  if (error) throw mapDbError(error, 'Falha ao consultar o evento da agenda.');
  if (!data) throw new ApiError(404, 'Evento da agenda não encontrado.');
  return fromRow(data);
}

async function create(payload) {
  assertReady();
  const row = toRow(payload);
  if (!row.id) row.id = newId('a');
  if (!row.status) row.status = 'agendado';
  const { data, error } = await supabase.from('agenda_events').insert(row).select().single();
  if (error) throw mapDbError(error, 'Falha ao criar o evento da agenda.');
  return fromRow(data);
}

async function update(id, patch) {
  assertReady();
  await getById(id);
  const row = toRow(patch);
  delete row.id;
  delete row.created_at;
  delete row.updated_at;
  if (Object.keys(row).length === 0) return getById(id);
  const { data, error } = await supabase.from('agenda_events').update(row).eq('id', id).select().single();
  if (error) throw mapDbError(error, 'Falha ao atualizar o evento da agenda.');
  return fromRow(data);
}

module.exports = { list, getById, create, update, COLUMNS, FILTERS };
