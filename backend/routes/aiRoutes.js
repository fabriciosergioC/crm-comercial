'use strict';

const crypto = require('node:crypto');
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { ApiError } = require('../middleware/errorHandler');
const V = require('../middleware/validate');
const config = require('../services/ai/aiConfig');
const store = require('../services/ai/aiSessionsStore');
const livekit = require('../services/livekit/livekitService');
const callsStore = require('../services/livekit/callsStore');
const whatsappAuto = require('../services/ai/whatsappAutoReply');

const router = express.Router();

/* Salas ativas só para reencontrar o link e encerrar sem depender do banco.
   O token enviado ao lead continua valendo até expirar mesmo se o backend
   reiniciar; o nome da sala é derivado do id da ligação. */
const callsAtivos = new Map();

function roomDaSessao(callId) {
  return `call_${String(callId || '').replace(/[^a-zA-Z0-9]/g, '')}`;
}

function apenasDigitos(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

function primeiroNome(value) {
  return String(value == null ? '' : value).trim().split(/\s+/)[0] || '';
}

/* Endereço público usado no link do lead: o configurado (Railway/ngrok) ou o
   host da própria requisição. Localhost é avisado porque o celular do cliente
   não alcança a máquina do escritório. */
function basePublica(req) {
  const configurada = String(config.livekit.publicBaseUrl || '').trim();
  if (configurada) return configurada.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function linkPublico(base, token) {
  /* O endereço wss vai junto: a página de ligação não tem outra forma de saber
     em qual projeto do LiveKit entrar. Não é segredo (a chave nunca sai). */
  return `${base}/ligacao.html?t=${encodeURIComponent(token)}&u=${encodeURIComponent(livekit.wsUrl())}`;
}

function statusLiveKit() {
  return livekit.status();
}

/* GET /api/ai/status — disponibilidade do que sobrou do motor local (llama e
   whisper) e do LiveKit. Nunca devolve caminho de arquivo, chave ou segredo. */
router.get('/status', asyncHandler(async (req, res) => {
  const refresh = String(req.query.refresh || '') === '1';
  const llama = require('../services/ai/llamaCppService');
  const whisper = require('../services/ai/whisperService');
  if (refresh) {
    llama.resetHealthCache();
    whisper.resetHealthCache();
    store.resetStorageCache();
    livekit.resetCache();
    callsStore.resetCache();
  }
  const [llamaHealth, whisperHealth, storage, callsStorage] = await Promise.all([
    llama.checkHealth({ force: refresh }).catch((error) => ({
      available: false,
      model: config.llama.model,
      detail: String((error && error.message) || error).slice(0, 200),
    })),
    whisper.checkHealth({ force: refresh }).catch((error) => ({
      available: false,
      model: config.whisper.model,
      detail: String((error && error.message) || error).slice(0, 200),
    })),
    store.storageStatus({ force: refresh }),
    callsStore.status({ force: refresh }),
  ]);
  res.json({
    success: true,
    data: {
      enabled: config.enabled,
      assistantName: config.assistantName,
      llama: llamaHealth,
      whisper: whisperHealth,
      storage,
      callsStorage,
      livekit: statusLiveKit(),
    },
  });
}));

/* GET /api/ai/sessions?leadId=&limit= — histórico de mensagens já gravado
   (resposta automática do WhatsApp). Só leitura: quem cria a sessão é o
   atendimento automático. Ligações têm histórico próprio em /calls. */
router.get('/sessions', asyncHandler(async (req, res) => {
  const leadId = req.query.leadId ? String(req.query.leadId).slice(0, 100) : '';
  const limit = Number(req.query.limit) || undefined;
  const data = await store.listSessions(leadId, limit);
  res.json({ success: true, count: data.length, data });
}));

/* GET /api/ai/sessions/:id — sessão + mensagens (reabrir histórico). */
router.get('/sessions/:id', asyncHandler(async (req, res) => {
  const session = await store.getSession(req.params.id);
  if (!session) throw new ApiError(404, 'Atendimento não encontrado.');
  const messages = await store.listMessages(req.params.id);
  res.json({ success: true, data: { session, messages } });
}));

/* --------------------------------------------------------------- ligações */

/* POST /api/ai/calls/:leadId   { user?, sendWhatsApp?, message? }
   Cria a sala no LiveKit e devolve dois links: o do atendente (abre na hora)
   e o do lead. Com sendWhatsApp=true, o link é enviado na conversa do lead
   pelo WhatsApp já conectado no CRM. */
router.post('/calls/:leadId', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['user', 'sendWhatsApp', 'message']);
  const leadId = String(req.params.leadId || '').slice(0, 100);
  const user = V.str(body, 'user', { max: 100 });
  const sendWhatsApp = V.bool(body, 'sendWhatsApp', { def: false });
  const mensagem = V.str(body, 'message', { max: 600, allowEmpty: true });

  if (!livekit.configured()) {
    throw new ApiError(503, 'LiveKit não configurado. Preencha LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET no backend/.env.');
  }

  const leadsService = require('../services/leadsService');
  const lead = await leadsService.getById(leadId);
  if (!lead) throw new ApiError(404, 'Lead não encontrado.');

  const telefone = apenasDigitos(lead.whatsapp || lead.phone);
  const nomeLead = String(lead.contactName || lead.company || 'Cliente').trim();
  const empresa = String(lead.company || '').trim();

  const callId = crypto.randomUUID();
  const room = roomDaSessao(callId);
  const ttlSeconds = config.livekit.tokenTtlMinutes * 60;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  const metadata = {
    kind: 'crm-call',
    callId,
    leadId,
    leadName: nomeLead,
    company: empresa,
    phone: telefone,
    assistantName: config.assistantName,
    companyName: config.companyName,
  };
  /* O contexto vai junto para o agente (quando houver) não inventar dado:
     cadastro, etapa, últimas interações etc., já enxuto pelo serviço. */
  try {
    const ctx = await require('../services/ai/leadContextService').buildContext(leadId);
    if (ctx && ctx.text) metadata.context = String(ctx.text).slice(0, 6000);
  } catch (_) { /* sem contexto a ligação continua */ }

  const warnings = [];
  await livekit.ensureRoom(room, { metadata: { callId, leadId } });
  const agente = await livekit.dispatchAgent(room, metadata);
  if (!agente.dispatched) warnings.push(agente.detail);

  const atendente = String(user || 'atendente').replace(/\s+/g, ' ').trim().slice(0, 60);
  const ownerToken = livekit.joinToken({
    room,
    identity: `atendente_${apenasDigitos(Date.now()).slice(-6)}_${callId.slice(0, 8)}`,
    name: atendente || 'Atendente',
    metadata: { role: 'owner', leadId, callId },
    ttlSeconds,
  });
  const guestToken = livekit.joinToken({
    room,
    identity: `lead_${callId.slice(0, 8)}`,
    name: nomeLead,
    metadata: { role: 'lead', leadId, callId },
    ttlSeconds,
  });

  const base = basePublica(req);
  if (/localhost|127\.0\.0\.1|\[::1\]/i.test(base)) {
    warnings.push('Este link aponta para localhost: o celular do lead não abre. Configure PUBLIC_BASE_URL com o endereço público (Railway ou ngrok).');
  }

  const inviteUrl = linkPublico(base, guestToken);
  const ownerUrl = linkPublico(base, ownerToken);
  const registro = await callsStore.create({
    id: callId,
    leadId,
    user: user || null,
    room,
    expiresAt,
    agent: agente.dispatched,
  });

  const call = {
    id: callId,
    room,
    leadId,
    inviteUrl,
    ownerUrl,
    createdAt: (registro && registro.startedAt) || new Date().toISOString(),
    expiresAt,
    agent: agente.dispatched,
  };
  /* Descarta entradas vencidas para o mapa não crescer sem limite. */
  for (const [chave, antiga] of callsAtivos) {
    if (Date.parse(antiga.expiresAt) < Date.now()) callsAtivos.delete(chave);
  }
  callsAtivos.set(callId, call);

  let enviado = null;
  if (sendWhatsApp) {
    try {
      const whatsapp = require('../services/whatsapp/WhatsAppService');
      const conversa = await whatsapp.openLeadConversation(leadId);
      if (!conversa || !conversa.id) throw new Error('não consegui abrir a conversa do WhatsApp deste lead');
      const texto = mensagem
        || `Olá${nomeLead ? `, ${primeiroNome(nomeLead)}` : ''}! Podemos conversar rapidinho por uma ligação? Abra este link no navegador do celular ou do computador, sem instalar nada: ${inviteUrl}`;
      await whatsapp.sendText(conversa.id, texto, user || 'CRM');
      enviado = { conversationId: conversa.id, message: texto };
    } catch (error) {
      warnings.push(`A ligação foi criada, mas o link não foi enviado no WhatsApp: ${String((error && error.message) || error).slice(0, 200)}`);
    }
  }

  res.status(201).json({
    success: true,
    data: {
      call,
      lead: { id: leadId, name: nomeLead, company: empresa, phone: telefone },
      whatsappSent: enviado,
      warnings,
    },
  });
}));

/* GET /api/ai/calls/:leadId — histórico de ligações deste lead. */
router.get('/calls/:leadId', asyncHandler(async (req, res) => {
  const leadId = String(req.params.leadId || '').slice(0, 100);
  const lista = await callsStore.list(leadId, 50);
  const data = (lista || []).map((item) => {
    const ativo = callsAtivos.get(item.id);
    return {
      id: item.id,
      room: item.room || (ativo ? ativo.room : roomDaSessao(item.id)),
      status: item.status,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      durationSeconds: item.durationSeconds,
      agent: Boolean(item.agent),
      inviteUrl: ativo ? ativo.inviteUrl : '',
      expiresAt: ativo ? ativo.expiresAt : item.expiresAt || null,
    };
  });
  res.json({ success: true, count: data.length, data });
}));

/* POST /api/ai/calls/:leadId/:callId/share   { user?, message? }
   Reenvia o link de uma ligação ainda aberta na conversa do WhatsApp do lead. */
router.post('/calls/:leadId/:callId/share', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['user', 'message']);
  const leadId = String(req.params.leadId || '').slice(0, 100);
  const callId = String(req.params.callId || '').slice(0, 100);
  const user = V.str(body, 'user', { max: 100 });
  const mensagem = V.str(body, 'message', { max: 600, allowEmpty: true });

  const ativo = callsAtivos.get(callId);
  if (!ativo || String(ativo.leadId) !== leadId) {
    throw new ApiError(409, 'Esta ligação não está mais aberta. Gere um novo link.');
  }
  if (Date.parse(ativo.expiresAt) < Date.now()) {
    callsAtivos.delete(callId);
    throw new ApiError(409, 'O link desta ligação expirou. Gere um novo link.');
  }
  try {
    const whatsapp = require('../services/whatsapp/WhatsAppService');
    const conversa = await whatsapp.openLeadConversation(leadId);
    if (!conversa || !conversa.id) throw new Error('não consegui abrir a conversa do WhatsApp deste lead');
    const texto = mensagem || `Podemos conversar por uma ligação rápida? Abra este link no navegador, sem instalar nada: ${ativo.inviteUrl}`;
    await whatsapp.sendText(conversa.id, texto, user || 'CRM');
    res.json({ success: true, data: { conversationId: conversa.id, message: texto } });
  } catch (error) {
    throw new ApiError(502, `A ligação está aberta, mas o link não foi enviado no WhatsApp: ${String((error && error.message) || error).slice(0, 200)}`);
  }
}));

/* POST /api/ai/calls/:leadId/:callId/end — encerra a sala e grava a duração. */
router.post('/calls/:leadId/:callId/end', asyncHandler(async (req, res) => {
  const leadId = String(req.params.leadId || '').slice(0, 100);
  const callId = String(req.params.callId || '').slice(0, 100);
  const registro = await callsStore.get(callId, leadId);
  if (!registro) throw new ApiError(404, 'Ligação não encontrada para este lead.');

  const ativo = callsAtivos.get(callId);
  const room = (ativo && ativo.room) || registro.room || roomDaSessao(callId);
  let salaEncerrada = false;
  try {
    salaEncerrada = await livekit.deleteRoom(room);
  } catch (error) {
    console.warn('[livekit] Não consegui encerrar a sala:', String((error && error.message) || error).slice(0, 200));
  }
  const inicio = registro.startedAt ? new Date(registro.startedAt).getTime() : Date.now();
  const duracao = Math.max(0, Math.round((Date.now() - inicio) / 1000));
  const atualizada = await callsStore.end(callId, { durationSeconds: duracao });
  callsAtivos.delete(callId);
  res.json({ success: true, data: { call: atualizada, roomEnded: salaEncerrada } });
}));

/* ------------------------------------------------------- WhatsApp automático */

/* GET /api/ai/whatsapp-auto/:leadId — a opção está ligada neste lead? O
   WhatsApp está conectado? A IA está no ar? Nada disso envia mensagem. */
router.get('/whatsapp-auto/:leadId', asyncHandler(async (req, res) => {
  const data = await whatsappAuto.statusForLead(req.params.leadId);
  res.json({ success: true, data });
}));

/* PUT /api/ai/whatsapp-auto/:leadId   { enabled, user? }
   Ativar aqui é a autorização explícita: a partir daí a IA responde sozinha
   no WhatsApp DESTE lead. Desativar é sempre permitido. */
router.put('/whatsapp-auto/:leadId', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['enabled', 'user']);
  const enabled = V.bool(body, 'enabled', { def: false });
  const user = V.str(body, 'user', { max: 100 });
  const data = await whatsappAuto.setEnabled(req.params.leadId, enabled, user);
  res.json({ success: true, data });
}));

/* POST /api/ai/whatsapp-auto/:leadId/start   { user? }
   A IA escreve e envia a PRIMEIRA mensagem ao cliente. Só em conversa nova,
   com a opção ligada, WhatsApp conectado e motor no ar. */
router.post('/whatsapp-auto/:leadId/start', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['user']);
  const user = V.str(body, 'user', { max: 100 });
  const data = await whatsappAuto.startConversation(req.params.leadId, user);
  res.status(201).json({ success: true, data });
}));

module.exports = router;
