const { supabase, isConfigured } = require('../config/supabase');
const { ApiError } = require('../middleware/errorHandler');
const { buildMapper, parseFilters, parseLimit, mapDbError, newId } = require('./modelHelpers');

/* Histórico de alterações do cliente (tabela client_updates).

   É um registro SOMENTE-INCLUSÃO: o front-end cria uma anotação e nunca
   edita nem apaga. Por isso aqui só existem list, getById e create —
   nenhuma operação que o sistema não usa (seção 14 do escopo). */

const COLUMNS = {
  id: 'id',
  clientId: 'client_id',
  date: 'date',
  type: 'type',
  note: 'note',
  createdAt: 'created_at',
};

const { toRow, fromRow } = buildMapper(COLUMNS);
const FILTERS = ['clientId'];

function assertReady() {
  if (!isConfigured || !supabase) {
    throw new ApiError(503, 'Supabase não configurado — defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do backend.');
  }
}

async function list(query) {
  assertReady();
  let q = supabase
    .from('client_updates')
    .select('*')
    .order('date', { ascending: false })
    .limit(parseLimit(query));

  for (const [column, value] of parseFilters(query, COLUMNS, FILTERS)) {
    q = q.eq(column, value);
  }

  const { data, error } = await q;
  if (error) throw mapDbError(error, 'Falha ao consultar as atualizações do cliente.');
  return (data || []).map(fromRow);
}

async function getById(id) {
  assertReady();
  const { data, error } = await supabase.from('client_updates').select('*').eq('id', id).maybeSingle();
  if (error) throw mapDbError(error, 'Falha ao consultar a atualização do cliente.');
  if (!data) throw new ApiError(404, 'Atualização não encontrada.');
  return fromRow(data);
}

/* payload validado na rota: { clientId, type, note?, date? } */
async function create(payload) {
  assertReady();
  const row = toRow(payload);
  if (!row.id) row.id = newId('cu');
  const { data, error } = await supabase.from('client_updates').insert(row).select().single();
  if (error) throw mapDbError(error, 'Falha ao registrar a atualização do cliente.');
  return fromRow(data);
}

module.exports = { list, getById, create, COLUMNS, FILTERS };