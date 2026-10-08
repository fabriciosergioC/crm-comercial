const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const agendaService = require('../services/agendaService');
const { ApiError } = require('../middleware/errorHandler');
const V = require('../middleware/validate');
const { AGENDA_EVENT_TYPES, AGENDA_EVENT_STATUSES } = require('../models/enums');

const router = express.Router();
const FIELDS = ['id', 'type', 'title', 'eventAt', 'leadId', 'owner', 'notes', 'status'];

router.get('/', asyncHandler(async (req, res) => {
  const data = await agendaService.list(req.query);
  res.json({ success: true, count: data.length, data });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const data = await agendaService.getById(req.params.id);
  res.json({ success: true, data });
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, FIELDS);
  const payload = {
    id: V.str(body, 'id', { max: 100 }),
    type: V.oneOf(body, 'type', AGENDA_EVENT_TYPES, { required: true }),
    title: V.str(body, 'title', { required: true, max: 200 }),
    eventAt: V.isoDate(body, 'eventAt', { required: true }),
    leadId: V.str(body, 'leadId', { max: 100 }),
    owner: V.str(body, 'owner', { max: 100 }),
    notes: V.str(body, 'notes', { max: 2000, allowEmpty: true }),
    status: V.oneOf(body, 'status', AGENDA_EVENT_STATUSES),
  };
  const data = await agendaService.create(payload);
  res.status(201).json({ success: true, data });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['type', 'title', 'eventAt', 'leadId', 'owner', 'notes', 'status']);
  const leadId = body.leadId === null
    ? null
    : V.str(body, 'leadId', { max: 100, allowEmpty: true });
  const patch = {
    type: V.oneOf(body, 'type', AGENDA_EVENT_TYPES),
    title: V.str(body, 'title', { max: 200 }),
    eventAt: V.isoDate(body, 'eventAt'),
    leadId: leadId === '' ? null : leadId,
    owner: V.str(body, 'owner', { max: 100, allowEmpty: true }),
    notes: V.str(body, 'notes', { max: 2000, allowEmpty: true }),
    status: V.oneOf(body, 'status', AGENDA_EVENT_STATUSES),
  };
  if (Object.values(patch).every((value) => value === undefined)) {
    throw new ApiError(400, 'Nenhum campo válido para atualizar.');
  }
  const data = await agendaService.update(req.params.id, patch);
  res.json({ success: true, data });
}));

module.exports = router;
