const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const leadsService = require('../services/leadsService');
const { ApiError } = require('../middleware/errorHandler');
const V = require('../middleware/validate');
const {
  STATUS_LIST, TEMPERATURES, PRIORITIES, SOURCES, SEGMENTS, LOSS_REASONS,
  CHANNELS, RESULTS,
} = require('../models/enums');

const router = express.Router();

/* Campos aceitos no corpo (whitelist). Qualquer outro => 400.
   O mapeamento camelCase <-> snake_case é o de leadsService.COLUMNS. */
const LEAD_FIELDS = [
  'id', 'company', 'contactName', 'phone', 'whatsapp', 'instagram', 'gmaps',
  'currentSite', 'city', 'neighborhood', 'segment', 'notes', 'owner', 'priority',
  'temperature', 'source', 'status', 'createdAt', 'lastContactAt', 'lossReason',
  'nextAction', 'score',
];

const TEXT = { max: 200, allowEmpty: true };

/* Monta o payload já validado. partial=true (PATCH) não exige campos
   obrigatórios e só inclui no objeto o que realmente veio. */
function leadPayload(body, { partial = false } = {}) {
  V.ensureObject(body);
  V.rejectUnknown(body, LEAD_FIELDS);
  const out = {};
  const set = (key, value) => { if (value !== undefined) out[key] = value; };
  const text = (field, { required = false, max = TEXT.max } = {}) =>
    V.str(body, field, { required: partial ? false : required, max, allowEmpty: true });

  set('id', V.str(body, 'id', { max: 100 }));
  set('company', text('company', { required: true }));
  set('contactName', text('contactName', { required: true }));
  set('owner', text('owner', { required: true, max: 100 }));

  set('phone', text('phone', { max: 50 }));
  set('whatsapp', text('whatsapp', { max: 50 }));
  set('instagram', text('instagram', { max: 100 }));
  set('gmaps', text('gmaps', { max: 500 }));
  set('currentSite', text('currentSite', { max: 300 }));
  set('city', text('city', { max: 120 }));
  set('neighborhood', text('neighborhood', { max: 120 }));
  set('segment', V.oneOf(body, 'segment', SEGMENTS));
  set('notes', text('notes', { max: 2000 }));
  set('priority', V.oneOf(body, 'priority', PRIORITIES));
  set('temperature', V.oneOf(body, 'temperature', TEMPERATURES));
  set('source', V.oneOf(body, 'source', SOURCES));
  set('status', V.oneOf(body, 'status', STATUS_LIST));
  set('lossReason', V.oneOf(body, 'lossReason', LOSS_REASONS));
  set('createdAt', V.isoDate(body, 'createdAt'));
  set('lastContactAt', V.isoDate(body, 'lastContactAt'));
  set('nextAction', V.nextAction(body, 'nextAction'));
  set('score', V.score(body, 'score'));
  return out;
}

/* GET /api/leads — todos, mais recentes primeiro (ordem em leadsService.list).
   O front-end filtra/busca em memória, como já faz hoje. */
router.get('/', asyncHandler(async (req, res) => {
  const data = await leadsService.list();
  res.json({ success: true, count: data.length, data });
}));

/* GET /api/leads/:id */
router.get('/:id', asyncHandler(async (req, res) => {
  const data = await leadsService.getById(req.params.id);
  res.json({ success: true, data });
}));

/* POST /api/leads */
router.post('/', asyncHandler(async (req, res) => {
  const payload = leadPayload(req.body);
  const data = await leadsService.create(payload);
  res.status(201).json({ success: true, data });
}));

/* PATCH /api/leads/:id */
router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = leadPayload(req.body, { partial: true });
  if (Object.keys(patch).length === 0) throw new ApiError(400, 'Nenhum campo válido para atualizar.');
  const data = await leadsService.update(req.params.id, patch);
  res.json({ success: true, data });
}));

/* POST /api/leads/:id/status   { status, user?, lossReason? }
   Muda status + grava histórico (RPC change_lead_status, atômica).
   Se vier lossReason (fluxo "Perdido"), grava em seguida — igual ao front. */
router.post('/:id/status', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['status', 'user', 'lossReason']);
  const status = V.oneOf(body, 'status', STATUS_LIST, { required: true });
  const user = V.str(body, 'user', { max: 100 });
  const lossReason = V.oneOf(body, 'lossReason', LOSS_REASONS);

  const result = await leadsService.changeStatus(req.params.id, status, user);
  if (lossReason && status === 'Perdido') {
    result.lead = await leadsService.update(req.params.id, { lossReason });
  }
  res.json({ success: true, data: result });
}));

/* POST /api/leads/:id/interactions   { channel, result, note?, user? }
   Registra o contato + atualiza lastContactAt/temperatura (RPC atômica). */
router.post('/:id/interactions', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['channel', 'result', 'note', 'user']);
  const interaction = {
    channel: V.oneOf(body, 'channel', CHANNELS, { required: true }),
    result: V.oneOf(body, 'result', RESULTS, { required: true }),
    note: V.str(body, 'note', { max: 1000, allowEmpty: true }),
    user: V.str(body, 'user', { max: 100 }),
  };
  const data = await leadsService.addInteraction(req.params.id, interaction);
  res.status(201).json({ success: true, data });
}));

module.exports = router;