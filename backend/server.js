require('dotenv').config();
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3001;

/* CORS restrito a origens permitidas (configuráveis via CORS_ORIGIN no .env).
   Evita Access-Control-Allow-Origin: * em produção. */
const allowedOrigins = (process.env.CORS_ORIGIN ||
  'http://localhost:5500,http://127.0.0.1:5500,http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Requisições sem Origin, file:// ("null"), origens permitidas ou domínios da Vercel (*.vercel.app).
      if (
        !origin ||
        origin === 'null' ||
        allowedOrigins.includes(origin) ||
        allowedOrigins.includes('*') ||
        origin.endsWith('.vercel.app')
      ) return callback(null, true);
      return callback(null, false);
    },
  })
);

app.use(express.json({ limit: '1mb' }));

app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[backend] API rodando em http://localhost:${PORT}/api`);
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.log('[backend] AVISO: credenciais do Supabase ausentes no .env — os endpoints de dados responderão 503 até serem configuradas.');
    }
  });
}

module.exports = app;
