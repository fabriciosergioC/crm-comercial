const { supabase, isConfigured } = require('../config/supabase');
const { ApiError } = require('../middleware/errorHandler');
const { TEMPERATURES, TEMP_RANK, HOT_RESULTS, WARM_RESULTS } = require('../models/enums');

/* ------------------------------------------------------------------
   Mapeamento camelCase (front-end) <-> snake_case (Postgres)
   ------------------------------------------------------------------ */

const COLUMNS = {
  id: 'id',
  company: 'company',
  contactName: 'contact_name',
  phone: 'phone',
  whatsapp: 'whatsapp',
  instagram: 'instagram',
  gmaps: 'gmaps',
  currentSite: 'current_site',
  city: 'city',
  neighborhood: 'neighborhood',
  segment: 'segment',
  notes: 'notes',
  owner: 'owner',
  priority: 'priority',
  temperature: 'temperature',
  source: 'source',
  status: 'status',
  createdAt: 'created_at',
  lastContactAt: 'last_contact_at',
  lossReason: 'loss_reason',
  nextAction: 'next_action',
  score: 'score',
};

const JSONB_FIELDS = ['next_action', 'score'];

function toRow(data) {
  const row = {};
  for (const [camel, snake] of Object.entries(COLUMNS)) {
    if (data[camel] !== undefined) row[snake] = data[camel];
  }
  return row;
}

function fromRow(row) {
  if (!row) return null;
  const lead = {};
  for (const [camel, snake] of Object.entries(COLUMNS)) {
    lead[camel] = row[snake] !== undefined ? row[snake] : null;
  }
  return lead;
}

/* ------------------------------------------------------------------
   Operações
   ------------------------------------------------------------------ */

function assertReady() {
  if (!isConfigured || !supabase) {
    throw new ApiError(503, 'Supabase não configurado — defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do backend.');
  }
}

async function list() {
  assertReady();
  const { data, error } = await supabase.from('leads').select('*').order('created_at', { ascending: false });
  if (error) throw new ApiError(502, 'Falha ao consultar leads no banco.');
  return (data || []).map(fromRow);
}

async function getById(id) {
  assertReady();
  const { data, error } = await supabase.from('leads').select('*').eq('id', id).maybeSingle();
  if (error) throw new ApiError(502, 'Falha ao consultar o lead no banco.');
  if (!data) throw new ApiError(404, 'Lead não encontrado.');
  return fromRow(data);
}

async function create(payload) {
  assertReady();
  const row = toRow(payload);
  row.temperature = TEMPERATURES.includes(row.temperature) ? row.temperature : 'Frio';
  const { data, error } = await supabase.from('leads').insert(row).select().single();
  if (error) throw new ApiError(502, 'Falha ao criar o lead no banco.');
  return fromRow(data);
}

async function update(id, patch) {
  assertReady();
  await getById(id); // 404 se não existir
  const row = toRow(patch);
  if (Object.keys(row).length === 0) return getById(id);
  const { data, error } = await supabase.from('leads').update(row).eq('id', id).select().single();
  if (error) throw new ApiError(502, 'Falha ao atualizar o lead no banco.');
  return fromRow(data);
}

/* CHANGE_STATUS: atualiza o status e registra o histórico atomicamente
   via RPC (ver backend/database/schema.sql — rpc_change_lead_status). */
async function changeStatus(id, status, user) {
  assertReady();
  await getById(id);
  const { data, error } = await supabase.rpc('change_lead_status', {
    p_lead_id: id,
    p_to: status,
    p_user: user || null,
  });
  if (error) throw new ApiError(502, 'Falha ao alterar o status do lead.');
  const entry = data && data.entry
    ? {
        id: data.entry.id,
        leadId: data.entry.lead_id,
        from: data.entry.from_status,
        to: data.entry.to_status,
        date: data.entry.date,
        user: data.entry.user,
      }
    : null;
  return { lead: fromRow(data && data.lead ? data.lead : data), entry };
}

/* ADD_INTERACTION: registra a interação e atualiza o lead
   (lastContactAt + temperatura, mesma regra de sugestão do front-end:
   a temperatura só sobe, nunca desce) atomicamente via RPC. */
async function addInteraction(leadId, interaction) {
  assertReady();
  await getById(leadId);
  const { data, error } = await supabase.rpc('add_lead_interaction', {
    p_lead_id: leadId,
    p_user: interaction.user || null,
    p_channel: interaction.channel,
    p_result: interaction.result,
    p_note: interaction.note || '',
  });
  if (error) throw new ApiError(502, 'Falha ao registrar a interação.');
  const created = data && data.interaction
    ? {
        id: data.interaction.id,
        leadId: data.interaction.lead_id,
        date: data.interaction.date,
        user: data.interaction.user,
        channel: data.interaction.channel,
        result: data.interaction.result,
        note: data.interaction.note,
      }
    : null;
  return { interaction: created, lead: fromRow(data && data.lead ? data.lead : data) };
}

module.exports = { list, getById, create, update, changeStatus, addInteraction, toRow, fromRow, COLUMNS, JSONB_FIELDS, TEMP_RANK, HOT_RESULTS, WARM_RESULTS };
