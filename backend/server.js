const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const followupNotifier = require('./services/followupNotifier');
const whatsappService = require('./services/whatsapp/WhatsAppService');

const app = express();
/* PORT/HOST permitem travar o bind em 127.0.0.1 em produção (atrás do nginx),
   deixando a porta 3001 invisível para a internet. Padrão inalterado: 0.0.0.0:3001 */
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

/* CORS restrito a origens permitidas (configuráveis via CORS_ORIGIN no .env).
   Evita Access-Control-Allow-Origin: * em produção. */
const allowedOrigins = (process.env.CORS_ORIGIN ||
  'http://localhost:5500,http://127.0.0.1:5500,http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  return (
    !origin ||
    origin === 'null' ||
    allowedOrigins.includes(origin) ||
    allowedOrigins.includes('*') ||
    origin.endsWith('.vercel.app')
  );
}

app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (
    req.method === 'OPTIONS' &&
    req.get('Access-Control-Request-Private-Network') === 'true' &&
    isAllowedOrigin(origin)
  ) {
    res.set('Access-Control-Allow-Private-Network', 'true');
  }
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      // Requisições sem Origin, file:// ("null"), origens permitidas ou domínios da Vercel (*.vercel.app).
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(null, false);
    },
  })
);

app.use(express.json({ limit: '1mb' }));

app.use('/api', routes);
app.use('/', routes);
app.use(express.static(path.join(__dirname, '..', 'frontend')));

app.use(notFound);
app.use(errorHandler);

/* Reconecta o WhatsApp (Baileys) ao subir o servidor, reaproveitando a sessão
   salva em WHATSAPP_AUTH_DIR — assim os lembretes de follow-up continuam
   chegando após um restart sem precisar escanear QR de novo. Se não houver
   sessão, o provider cai no fluxo normal (QR/pairing) e o erro é só logado.
   Desative com WHATSAPP_AUTOSTART=false. */
function autostartWhatsApp() {
  if (String(process.env.WHATSAPP_AUTOSTART || 'true').toLowerCase() === 'false') return;
  const provider = process.env.WHATSAPP_PROVIDER || 'baileys';
  if (provider !== 'baileys') return;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[whatsapp] Auto-conexão ignorada: configure o Supabase primeiro.');
    return;
  }
  console.log('[whatsapp] Auto-conexão iniciada (reaproveitando sessão salva)...');
  whatsappService
    .connect({ phoneNumber: process.env.WHATSAPP_PAIRING_PHONE || '' })
    .then((status) => console.log(`[whatsapp] Status após auto-conexão: ${status && status.status}.`))
    .catch((error) => console.warn(`[whatsapp] Auto-conexão falhou: ${error.message || error}`));
}

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`[backend] API rodando em http://${HOST}:${PORT}/api`);
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.log('[backend] AVISO: credenciais do Supabase ausentes no .env — os endpoints de dados responderão 503 até serem configuradas.');
    }
    /* O agendador e o WhatsApp precisam de processo Node persistente;
       na Vercel serverless nenhum dos dois roda (Baileys exige socket contínuo). */
    if (process.env.VERCEL !== '1') {
      autostartWhatsApp();
      followupNotifier.start();
    }
  });
}

module.exports = app;
