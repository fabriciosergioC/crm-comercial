const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const demosService = require('../services/demosService');
const { ApiError } = require('../middleware/errorHandler');
const V = require('../middleware/validate');

const router = express.Router();

/* Campos aceitos (whitelist do banco: lead_demos). */
const FIELDS = ['id', 'leadId', 'url', 'createdAt', 'sentAt', 'validityHours',
  'expiresAt', 'owner', 'deactivated', 'views', 'lastViewedAt'];

/* GET /api/demos?leadId=&owner=&deactivated=&limit= */
router.get('/', asyncHandler(async (req, res) => {
  const data = await demosService.list(req.query);
  res.json({ success: true, count: data.length, data });
}));

/* GET /api/demos/:id */
router.get('/:id', asyncHandler(async (req, res) => {
  const data = await demosService.getById(req.params.id);
  res.json({ success: true, data });
}));

/* POST /api/demos   { leadId, url, validityHours?, owner?, sentAt? }
   Com sentAt (enviada agora), a expiração é calculada pelo prazo de validade. */
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, FIELDS);
  const payload = {
    id: V.str(body, 'id', { max: 100 }),
    leadId: V.str(body, 'leadId', { required: true, max: 100 }),
    url: V.str(body, 'url', { required: true, max: 1000 }),
    createdAt: V.isoDate(body, 'createdAt'),
    sentAt: V.isoDate(body, 'sentAt'),
    validityHours: V.int(body, 'validityHours', { min: 1, max: 720 }),
    owner: V.str(body, 'owner', { max: 100 }),
  };
  const data = await demosService.create(payload);
  res.status(201).json({ success: true, data });
}));

/* PATCH /api/demos/:id   { url?, validityHours?, sentAt?, expiresAt?,
                            deactivated?, views?, lastViewedAt? }
   "Marcar como enviada" = { sentAt } (a expiração sai do prazo de validade);
   "Desativar" = { deactivated: true }. Não existe delete de demo. */
router.patch('/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['url', 'validityHours', 'sentAt', 'expiresAt', 'deactivated', 'views', 'lastViewedAt']);
  const patch = {
    url: V.str(body, 'url', { max: 1000, allowEmpty: true }),
    validityHours: V.int(body, 'validityHours', { min: 1, max: 720 }),
    sentAt: V.isoDate(body, 'sentAt'),
    expiresAt: V.isoDate(body, 'expiresAt'),
    deactivated: V.bool(body, 'deactivated'),
    views: V.int(body, 'views', { min: 0, max: 1000000 }),
    lastViewedAt: V.isoDate(body, 'lastViewedAt'),
  };
  if (Object.values(patch).every((v) => v === undefined)) {
    throw new ApiError(400, 'Nenhum campo válido para atualizar.');
  }
  const data = await demosService.update(req.params.id, patch);
  res.json({ success: true, data });
}));

module.exports = router;