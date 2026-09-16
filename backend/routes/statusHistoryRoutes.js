const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const statusHistoryService = require('../services/statusHistoryService');
const { ApiError } = require('../middleware/errorHandler');

const router = express.Router();

/* GET /api/status-history             -> histórico de todos os leads
   GET /api/status-history?leadId=l1   -> histórico de um lead
   (statusHistoryService.list já aceita leadId opcional) */
router.get('/', asyncHandler(async (req, res) => {
  const { leadId } = req.query;
  if (leadId !== undefined && (typeof leadId !== 'string' || leadId.trim() === '')) {
    throw new ApiError(400, 'Parâmetro leadId inválido.');
  }
  const data = await statusHistoryService.list(leadId ? leadId.trim() : undefined);
  res.json({ success: true, count: data.length, data });
}));

module.exports = router;