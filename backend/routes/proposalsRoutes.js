const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const proposalsService = require('../services/proposalsService');
const { ApiError } = require('../middleware/errorHandler');
const V = require('../middleware/validate');
const { PLANS, PROPOSAL_STATUSES } = require('../models/enums');

const router = express.Router();

/* Campos aceitos (whitelist do banco: lead_proposals). */
const FIELDS = ['id', 'leadId', 'plan', 'implementationValue', 'monthlyValue',
  'proposalDate', 'validUntil', 'notes', 'status'];

/* GET /api/proposals?leadId=&status=&limit= */
router.get('/', asyncHandler(async (req, res) => {
  const data = await proposalsService.list(req.query);
  res.json({ success: true, count: data.length, data });
}));

/* GET /api/proposals/:id */
router.get('/:id', asyncHandler(async (req, res) => {
  const data = await proposalsService.getById(req.params.id);
  res.json({ success: true, data });
}));

/* POST /api/proposals
   { leadId, plan, implementationValue?, monthlyValue?, proposalDate?,
     validUntil?, notes?, status? } */
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, FIELDS);
  const payload = {
    id: V.str(body, 'id', { max: 100 }),
    leadId: V.str(body, 'leadId', { required: true, max: 100 }),
    plan: V.oneOf(body, 'plan', PLANS, { required: true }),
    implementationValue: V.num(body, 'implementationValue', { min: 0, max: 10000000 }),
    monthlyValue: V.num(body, 'monthlyValue', { min: 0, max: 1000000 }),
    proposalDate: V.isoDate(body, 'proposalDate'),
    validUntil: V.isoDate(body, 'validUntil'),
    notes: V.str(body, 'notes', { max: 2000, allowEmpty: true }),
    status: V.oneOf(body, 'status', PROPOSAL_STATUSES),
  };
  const data = await proposalsService.create(payload);
  res.status(201).json({ success: true, data });
}));

/* PATCH /api/proposals/:id
   { plan?, implementationValue?, monthlyValue?, validUntil?, notes?, status? }
   Mudar o status (Aprovada / Recusada / Em negociação) é o caminho do app —
   não existe delete de proposta. */
router.patch('/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['plan', 'implementationValue', 'monthlyValue', 'validUntil', 'notes', 'status']);
  const patch = {
    plan: V.oneOf(body, 'plan', PLANS),
    implementationValue: V.num(body, 'implementationValue', { min: 0, max: 10000000 }),
    monthlyValue: V.num(body, 'monthlyValue', { min: 0, max: 1000000 }),
    validUntil: V.isoDate(body, 'validUntil'),
    notes: V.str(body, 'notes', { max: 2000, allowEmpty: true }),
    status: V.oneOf(body, 'status', PROPOSAL_STATUSES),
  };
  if (Object.values(patch).every((v) => v === undefined)) {
    throw new ApiError(400, 'Nenhum campo válido para atualizar.');
  }
  const data = await proposalsService.update(req.params.id, patch);
  res.json({ success: true, data });
}));

module.exports = router;