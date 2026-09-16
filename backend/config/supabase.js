const { createClient } = require('@supabase/supabase-js');

/* As credenciais vêm SEMPRE de variáveis de ambiente (.env) — nunca hardcoded.
   A SUPABASE_SERVICE_ROLE_KEY é secreta e só vive aqui, no servidor. */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const isConfigured = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

if (!isConfigured) {
  console.error('[supabase] AVISO: SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY não definidos no .env.');
}

const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

module.exports = { supabase, isConfigured };
