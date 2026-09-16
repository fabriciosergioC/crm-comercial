const { supabase, isConfigured } = require('../config/supabase');
const { ApiError } = require('../middleware/errorHandler');
const { buildMapper, parseFilters, parseLimit, mapDbError } = require('./modelHelpers');
const leadsService = require('./leadsService');

/* Interações (tabela lead_interactions).

   A ESCRITA é delegada a leadsService.addInteraction de propósito: gravar a
   interação precisa ser ATÔMICO com a atualização do lead (last_contact_at +
   temperatura que só sobe), e isso é feito pela RPC add_lead_interaction no
   banco. Aqui ficam as leituras (usadas nos relatórios do front). */

const COLUMNS = {
  id: 'id',
  leadId: 'lead_id',
  date: 'date',
  user: 'user',
  channel: 'channel',
  result: 'result',
  note: 'note',
  createdAt: 'created_at',
};

const { fromRow } = buildMapper(COLUMNS);

/* Filtros aceitos na querystring. */
const FILTERS = ['leadId', 'channel', 'user'];

function assertReady() {
  if (!isConfigured || !supabase) {
    throw new ApiError(503, 'Supabase não configurado — defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do backend.');
  }
}

/* list({ leadId?, channel?, user?, limit? }) */
async function list(query) {
  assertReady();
  let q = supabase
    .from('lead_interactions')
    .select('*')
    .order('date', { ascending: false })
    .limit(parseLimit(query));

  for (const [column, value] of parseFilters(query, COLUMNS, FILTERS)) {
    q = q.eq(column, value);
  }

  const { data, error } = await q;
  if (error) throw mapDbError(error, 'Falha ao consultar as interações.');
  return (data || []).map(fromRow);
}

/* Cria a interação de forma atômica (RPC). data: { channel, result, note, user } */
async function create(leadId, data) {
  return leadsService.addInteraction(leadId, data);
}

module.exports = { list, create, COLUMNS, FILTERS };