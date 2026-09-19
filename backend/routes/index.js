const express = require('express');

/* ===========================================================================
   Agregador das rotas da API. É este arquivo que backend/server.js já importa
   (require('./routes')), então nenhuma alteração foi necessária no server.

   Cada recurso tem o seu arquivo de rotas; o acesso ao banco fica nos services
   (routes -> services -> Supabase).

   Nenhum recurso expõe DELETE: a aplicação não apaga dados — ela muda estado
   (follow-up "cancelado", demo "deactivated", proposta "Recusada").
   =========================================================================== */

const router = express.Router();

/* Infraestrutura */
router.use('/health', require('./healthRoute'));
router.use('/auth', require('./authRoutes'));

/* Núcleo comercial */
router.use('/leads', require('./leadsRoutes'));
router.use('/status-history', require('./statusHistoryRoutes'));
router.use('/interactions', require('./interactionsRoutes'));

/* Coleções de apoio ao lead / pós-venda */
router.use('/followups', require('./followupsRoutes'));
router.use('/demos', require('./demosRoutes'));
router.use('/proposals', require('./proposalsRoutes'));
router.use('/clients', require('./clientsRoutes'));
router.use('/client-updates', require('./clientUpdatesRoutes'));

module.exports = router;