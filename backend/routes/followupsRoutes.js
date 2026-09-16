const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const followupsService = require('../services/followupsService');
const { ApiError } = require('../middleware/errorHandler');
const V = require('../middleware/validate');
const { FOLLOWUP_STATUSES } = require('../models/enums');

const router = express.Router();

/* Campos aceitos (whitelist do banco: lead_followups). */
const FIELDS = ['id', 'leadId', 'dueDate', 'note', 'status', 'createdBy'];

/* GET /api/followups?leadId=&status=&createdBy=&limit= */
router.get('/', asyncHandler(async (req, res) => {
  const data = await followupsService.list(req.query);
  res.json({ success: true, count: data.length, data });
}));

/* GET /api/followups/:id */
router.get('/:id', asyncHandler(async (req, res) => {
  const data = await followupsService.getById(req.params.id);
  res.json({ success: true, data });
}));

/* POST /api/followups   { leadId, dueDate?, note?, status?, createdBy? } */
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, FIELDS);
  const payload = {
    id: V.str(body, 'id', { max: 100 }),
    leadId: V.str(body, 'leadId', { required: true, max: 100 }),
    dueDate: V.isoDate(body, 'dueDate'),
    note: V.str(body, 'note', { max: 1000, allowEmpty: true }),
    status: V.oneOf(body, 'status', FOLLOWUP_STATUSES),
    createdBy: V.str(body, 'createdBy', { max: 100 }),
  };
  const data = await followupsService.create(payload);
  res.status(201).json({ success: true, data });
}));

/* PATCH /api/followups/:id   { dueDate?, note?, status? }
   É assim que o app conclui ("concluido"), reagenda (nova dueDate) ou
   cancela ("cancelado") — não existe delete de follow-up. */
router.patch('/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['dueDate', 'note', 'status']);
  const patch = {
    dueDate: V.isoDate(body, 'dueDate'),
    note: V.str(body, 'note', { max: 1000, allowEmpty: true }),
    status: V.oneOf(body, 'status', FOLLOWUP_STATUSES),
  };
  if (Object.values(patch).every((v) => v === undefined)) {
    throw new ApiError(400, 'Nenhum campo válido para atualizar.');
  }
  const data = await followupsService.update(req.params.id, patch);
  res.json({ success: true, data });
}));

module.exports = router;