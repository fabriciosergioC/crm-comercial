const { supabase, isConfigured } = require('../config/supabase');
const { ApiError } = require('../middleware/errorHandler');

/* Histórico de mudanças de status do lead (lead_status_history).
   Escrita feita atomicamente junto com o lead via RPC — ver leadsService
   e backend/database/schema.sql. Aqui ficam apenas as leituras. */

function assertReady() {
  if (!isConfigured || !supabase) {
    throw new ApiError(503, 'Supabase não configurado — defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do backend.');
  }
}

async function list(leadId) {
  assertReady();
  let query = supabase.from('lead_status_history').select('*').order('date', { ascending: false });
  if (leadId) query = query.eq('lead_id', leadId);
  const { data, error } = await query;
  if (error) throw new ApiError(502, 'Falha ao consultar o histórico de status.');
  return (data || []).map((r) => ({
    id: r.id,
    leadId: r.lead_id,
    from: r.from_status,
    to: r.to_status,
    date: r.date,
    user: r.user,
  }));
}

module.exports = { list };
