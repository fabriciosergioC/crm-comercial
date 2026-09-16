const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const clientsService = require('../services/clientsService');
const { ApiError } = require('../middleware/errorHandler');
const V = require('../middleware/validate');
const { PLANS } = require('../models/enums');

const router = express.Router();

/* Campos aceitos (whitelist do banco: clients). */
const FIELDS = ['id', 'leadId', 'company', 'contactName', 'plan',
  'contractedValue', 'monthlyValue', 'closingDate', 'publishDate', 'domain',
  'owner', 'notes', 'status'];

/* GET /api/clients?leadId=&owner=&status=&limit= */
router.get('/', asyncHandler(async (req, res) => {
  const data = await clientsService.list(req.query);
  res.json({ success: true, count: data.length, data });
}));

/* GET /api/clients/:id */
router.get('/:id', asyncHandler(async (req, res) => {
  const data = await clientsService.getById(req.params.id);
  res.json({ success: true, data });
}));

/* POST /api/clients  (conversão de lead em cliente — CONVERT_TO_CLIENT)
   { leadId?, company, contactName, plan, contractedValue?, monthlyValue?,
     closingDate?, publishDate?, domain?, owner?, notes?, status? }
   Não altera o status do lead: o front-end também não altera nesse passo. */
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, FIELDS);
  const payload = {
    id: V.str(body, 'id', { max: 100 }),
    leadId: V.str(body, 'leadId', { max: 100 }),
    company: V.str(body, 'company', { required: true, max: 200 }),
    contactName: V.str(body, 'contactName', { required: true, max: 200 }),
    plan: V.oneOf(body, 'plan', PLANS, { required: true }),
    contractedValue: V.num(body, 'contractedValue', { min: 0, max: 10000000 }),
    monthlyValue: V.num(body, 'monthlyValue', { min: 0, max: 1000000 }),
    closingDate: V.isoDate(body, 'closingDate'),
    publishDate: V.isoDate(body, 'publishDate'),
    domain: V.str(body, 'domain', { max: 300, allowEmpty: true }),
    owner: V.str(body, 'owner', { max: 100 }),
    notes: V.str(body, 'notes', { max: 2000, allowEmpty: true }),
    status: V.str(body, 'status', { max: 50 }),
  };
  const data = await clientsService.create(payload);
  res.status(201).json({ success: true, data });
}));

/* PATCH /api/clients/:id
   { company?, contactName?, plan?, contractedValue?, monthlyValue?,
     publishDate?, domain?, owner?, notes?, status? } */
router.patch('/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['company', 'contactName', 'plan', 'contractedValue', 'monthlyValue', 'publishDate', 'domain', 'owner', 'notes', 'status']);
  const patch = {
    company: V.str(body, 'company', { max: 200, allowEmpty: true }),
    contactName: V.str(body, 'contactName', { max: 200, allowEmpty: true }),
    plan: V.oneOf(body, 'plan', PLANS),
    contractedValue: V.num(body, 'contractedValue', { min: 0, max: 10000000 }),
    monthlyValue: V.num(body, 'monthlyValue', { min: 0, max: 1000000 }),
    publishDate: V.isoDate(body, 'publishDate'),
    domain: V.str(body, 'domain', { max: 300, allowEmpty: true }),
    owner: V.str(body, 'owner', { max: 100 }),
    notes: V.str(body, 'notes', { max: 2000, allowEmpty: true }),
    status: V.str(body, 'status', { max: 50, allowEmpty: true }),
  };
  if (Object.values(patch).every((v) => v === undefined)) {
    throw new ApiError(400, 'Nenhum campo válido para atualizar.');
  }
  const data = await clientsService.update(req.params.id, patch);
  res.json({ success: true, data });
}));

module.exports = router;