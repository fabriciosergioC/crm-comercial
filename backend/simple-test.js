const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

console.log('=== Teste de Conectividade com Banco de Dados ===');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('URL:', SUPABASE_URL);
console.log('Key length:', SUPABASE_SERVICE_ROLE_KEY ? SUPABASE_SERVICE_ROLE_KEY.length : 0);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.log('❌ Credenciais faltando!');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

async function testConnection() {
    try {
        console.log('🔄 Testando consulta...');
        const { data, error, count } = await supabase
            .from('leads')
            .select('*', { count: 'exact' })
            .limit(1);
            
        if (error) {
            console.log('❌ Erro na consulta:', error.message);
            console.log('Detalhes:', error);
            return false;
        }
        
        console.log('✅ Conexão com o banco estabelecida com sucesso!');
        console.log('📊 Resultado do teste:', data);
        console.log('📈 Total de registros na tabela leads:', count);
        return true;
        
    } catch (err) {
        console.log('❌ Erro ao testar conexão:', err.message);
        console.log('Stack trace:', err.stack);
        return false;
    }
}

testConnection();