const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const agendaService = require('../services/agendaService');
const agendaNotifier = require('../services/agendaNotifier');
const windowsToast = require('../services/windowsToast');
const { ApiError } = require('../middleware/errorHandler');
const V = require('../middleware/validate');
const { AGENDA_EVENT_TYPES, AGENDA_EVENT_STATUSES } = require('../models/enums');

const router = express.Router();
const FIELDS = ['id', 'type', 'title', 'eventAt', 'leadId', 'owner', 'notes', 'status'];

/* POST /api/agenda/notify — dispara UMA varredura manual do agendador da agenda
   (mesma ideia de POST /api/followups/notify, mas avisando no Windows, não no
   celular). Roda os itens que estão na janela de aviso; o estado em
   data/agenda-notifier-state.json evita repetir lembrete já dado. */
router.post('/notify', asyncHandler(async (req, res) => {
  const data = await agendaNotifier.runOnce({ force: Boolean(req.body && req.body.force) });
  res.json({ success: true, data });
}));

/* POST /api/agenda/notify-test — manda um toast de exemplo para o Windows,
   sem depender de ter item na janela. Não toca no banco nem no estado. */
router.post('/notify-test', asyncHandler(async (req, res) => {
  const data = await agendaNotifier.sendTestToast();
  res.json({ success: true, data });
}));

/* GET /api/agenda/notify-status — o que o agendador está configurado para fazer
   (usado pelo bloco de notificações no menu Agenda). */
router.get('/notify/status', asyncHandler(async (req, res) => {
  const enabled = String(process.env.AGENDA_NOTIFY_ENABLED || 'true').toLowerCase() !== 'false';
  res.json({
    success: true,
    data: {
      enabled,
      windows: windowsToast.isSupported(),
      intervalMin: Math.round(agendaNotifier.config.intervalMs() / 60000),
      leadMin: Math.round(agendaNotifier.config.leadMs() / 60000),
      lateMin: Math.round(agendaNotifier.config.lateMs() / 60000),
      summary: String(process.env.AGENDA_NOTIFY_SUMMARY || 'true').toLowerCase() !== 'false',
    },
  });
}));

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
