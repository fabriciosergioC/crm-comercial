const express = require('express');
const { sessionGate } = require('../middleware/sessionGate');

/* ===========================================================================
   Agregador das rotas da API. É este arquivo que backend/server.js já importa
   (require('./routes')), então nenhuma alteração foi necessária no server.

   Cada recurso tem o seu arquivo de rotas; o acesso ao banco fica nos services
   (routes -> services -> Supabase).

   A regra da aplicação é mudar estado em vez de apagar (follow-up "cancelado",
   demo "deactivated", proposta "Recusada", venda "Cancelada"). As três excessões
   são apagamento que não deixa rastro quebrado: lead sem cliente vinculado,
   conversa do WhatsApp vazia e lançamento do Financeiro digitado errado — nos
   três a confirmação é na tela, antes de chamar a rota.
   =========================================================================== */

const router = express.Router();

/* Portão de sessão: corre antes de qualquer rota de dados. /health e /auth
   continuam abertos (é pelo login que se consegue a sessão) e o seu notebook,
   com Host localhost, passa sem token nenhum. */
router.use(sessionGate);

/* Infraestrutura */
router.use('/health', require('./healthRoute'));
router.use('/auth', require('./authRoutes'));

/* Núcleo comercial */
router.use('/leads', require('./leadsRoutes'));
router.use('/status-history', require('./statusHistoryRoutes'));
router.use('/interactions', require('./interactionsRoutes'));

/* Coleções de apoio ao lead / pós-venda */
router.use('/followups', require('./followupsRoutes'));
router.use('/agenda', require('./agendaRoutes'));
router.use('/demos', require('./demosRoutes'));
router.use('/proposals', require('./proposalsRoutes'));
router.use('/clients', require('./clientsRoutes'));
router.use('/client-updates', require('./clientUpdatesRoutes'));

/* Financeiro: vendas avulsas, recebimentos e comissão (migration 014) */
router.use('/finance', require('./financeRoutes'));

/* Captura e enriquecimento de empresas (OpenStreetMap) */
router.use('/enrichment', require('./enrichmentRoutes'));
router.use('/whatsapp', require('./whatsappRoutes'));

module.exports = router;