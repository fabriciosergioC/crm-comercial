const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const clientUpdatesService = require('../services/clientUpdatesService');
const V = require('../middleware/validate');

const router = express.Router();

/* Campos aceitos (whitelist do banco: client_updates).
   Registro somente-inclusão: sem PATCH e sem DELETE. */
const FIELDS = ['id', 'clientId', 'date', 'type', 'note'];

/* GET /api/client-updates?clientId=&limit= */
router.get('/', asyncHandler(async (req, res) => {
  const data = await clientUpdatesService.list(req.query);
  res.json({ success: true, count: data.length, data });
}));

/* GET /api/client-updates/:id */
router.get('/:id', asyncHandler(async (req, res) => {
  const data = await clientUpdatesService.getById(req.params.id);
  res.json({ success: true, data });
}));

/* POST /api/client-updates   { clientId, type, note?, date? } */
router.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, FIELDS);
  const payload = {
    id: V.str(body, 'id', { max: 100 }),
    clientId: V.str(body, 'clientId', { required: true, max: 100 }),
    type: V.str(body, 'type', { required: true, max: 100 }),
    note: V.str(body, 'note', { max: 2000, allowEmpty: true }),
    date: V.isoDate(body, 'date'),
  };
  const data = await clientUpdatesService.create(payload);
  res.status(201).json({ success: true, data });
}));

module.exports = router;