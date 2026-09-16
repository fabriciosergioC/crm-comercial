const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const interactionsService = require('../services/interactionsService');

const router = express.Router();

/* GET /api/interactions?leadId=&channel=&user=&limit=
   SOMENTE LEITURA: criar interação mexe também no lead (last_contact_at +
   temperatura) de forma atômica, por isso a escrita vive em
   POST /api/leads/:id/interactions (RPC add_lead_interaction). */
router.get('/', asyncHandler(async (req, res) => {
  const data = await interactionsService.list(req.query);
  res.json({ success: true, count: data.length, data });
}));

module.exports = router;