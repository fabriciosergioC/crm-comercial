'use strict';

/* ===========================================================================
   Resposta automática da IA no WhatsApp.

   Como funciona, do início ao fim:
   - o atendente liga a opção em UM lead (aba "IA por voz" -> atendimento no
     WhatsApp). Sem esse "ligar" explícito, nada é enviado a ninguém;
   - quando chega mensagem de texto real desse lead (não grupo, não mídia, não
     eco do próprio CRM), a mensagem entra na conversa do WhatsApp e aqui é
     enfileirada por 2,5 s — várias mensagens seguidas viram UMA resposta só;
   - a resposta nasce com o mesmo contexto do lead usado no painel de voz e vai
     pelo mesmo WhatsApp já conectado no CRM, registrada como "IA Sofia";
   - o histórico fica em uma sessão própria (channel = 'whatsapp'), para não se
     misturar com as conversas por voz do painel.

   Limites por segurança: só texto, no máximo 8 respostas por conversa a cada
   10 minutos, nada de inventar preço/condição (instrução no prompt) e toda
   falha (motor fora do ar, WhatsApp desconectado) apenas ignora a resposta —
   nunca envia mensagem de erro para o cliente.
   ========================================================================== */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./aiConfig');
const store = require('./aiSessionsStore');
const leadContext = require('./leadContextService');
const llama = require('./llamaCppService');
const leadsService = require('../leadsService');
const { normalizeWhatsAppPhone } = require('../whatsapp/phoneUtils');
const { supabase, isConfigured } = require('../../config/supabase');
const { ApiError } = require('../../middleware/errorHandler');

const SETTINGS_TABLE = 'lead_ai_whatsapp_auto';
const DEBOUNCE_MS = config.limits.whatsappAutoDelayMs;
const SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_REPLIES_PER_WINDOW = config.limits.whatsappAutoMaxReplies;
const REPLY_WINDOW_MS = 10 * 60 * 1000;
const MAX_REPLY_CHARS = 900;
const PHONE_CACHE_MS = 60000;

const settingsMemory = new Map();
const pending = new Map();
const replying = new Set();
const starting = new Set();
const replyLog = new Map();
/* A mesma mensagem pode chegar duas vezes (histórico + aviso ao vivo, ou o
   WhatsApp reentregando). Guardamos o id por 20 min para não responder em
   dobro. */
const idsTratados = new Map();
const ID_TTL_MS = 20 * 60 * 1000;
let phoneCache = { at: 0, leads: [] };
let settingsDurable = false;
let deps = null;

/* Diário do atendimento automático em data/ia-whatsapp.log. Sem isso, "a IA
   não respondeu" não deixa rastro nenhum: cada decisão (recebida, ignorada,
   respondida, falha) fica registrada com hora. Rotação simples em 1 MB. */
const LOG_FILE = path.join(__dirname, '../../data/ia-whatsapp.log');
function logIA(evento, dados) {
  const linha = `${new Date().toISOString()} ${evento}${dados ? ` ${JSON.stringify(dados)}` : ''}`;
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    fs.appendFileSync(LOG_FILE, `${linha}\n`);
  } catch (_) { /* log nunca derruba o atendimento */ }
}

function useStore() { return deps?.store || store; }
function useLlama() { return deps?.llama || llama; }
function useLeadContext() { return deps?.leadContext || leadContext; }
function useLeads() { return deps?.leads || leadsService; }

async function sendWhatsApp(conversationId, content, sentBy) {
  if (deps?.sendText) return deps.sendText(conversationId, content, sentBy);
  // Require tardio: evita carregar o Baileys (e abrir socket) só por importar
  // este módulo, e evita ciclo com o provider do WhatsApp.
  const whatsapp = require('../whatsapp/WhatsAppService');
  return whatsapp.sendText(conversationId, content, sentBy);
}

async function whatsAppStatus() {
  if (deps?.whatsAppStatus) return deps.whatsAppStatus();
  const whatsapp = require('../whatsapp/WhatsAppService');
  return whatsapp.getStatus();
}

/* Abre (ou reaproveita, inclusive no número irmão) a conversa do WhatsApp do
   lead. É o mesmo caminho do botão "Abrir no WhatsApp" do CRM. */
async function openConversation(leadId) {
  if (deps?.openConversation) return deps.openConversation(leadId);
  const whatsapp = require('../whatsapp/WhatsAppService');
  return whatsapp.openLeadConversation(leadId);
}

/* ---------------------------------------------------------------- ajustes */

function settingsAvailable() {
  return Boolean(isConfigured) && config.storage.mode !== 'memory';
}

async function getSetting(leadId) {
  const guardado = settingsMemory.get(leadId);
  if (settingsAvailable()) {
    const { data, error } = await supabase
      .from(SETTINGS_TABLE)
      .select('lead_id, enabled, updated_at')
      .eq('lead_id', leadId)
      .maybeSingle();
    if (!error) {
      settingsDurable = true;
      const doBanco = { enabled: Boolean(data && data.enabled), updatedAt: data ? data.updated_at : null, durable: true };
      /* Uma gravação que caiu só na memória (banco fora do ar na hora de
         ligar) é mais nova que o banco: ligar precisa valer já, sem esperar o
         próximo deploy. */
      if (guardado && (Date.parse(guardado.updatedAt) || 0) > (Date.parse(doBanco.updatedAt) || 0)) {
        return { enabled: Boolean(guardado.enabled), updatedAt: guardado.updatedAt, durable: true };
      }
      return doBanco;
    }
    settingsDurable = false;
    console.warn('[ia-whatsapp] Não consegui ler o ajuste no banco; usando a cópia local:', error.message);
  }
  return { enabled: Boolean(guardado && guardado.enabled), updatedAt: guardado ? guardado.updatedAt : null, durable: false };
}

async function setSetting(leadId, enabled, user) {
  const agora = new Date().toISOString();
  if (settingsAvailable()) {
    let linha = { lead_id: leadId, enabled: Boolean(enabled), user: user || null, updated_at: agora };
    let { error } = await supabase.from(SETTINGS_TABLE).upsert(linha, { onConflict: 'lead_id' });
    /* 23503 = o "user" não existe na tabela users (nome em vez de id, conta
       apagada). O ajuste é do lead, não do usuário: grava sem ele em vez de
       deixar o toggle só na memória. */
    if (error && error.code === '23503' && linha.user) {
      linha = { ...linha, user: null };
      ({ error } = await supabase.from(SETTINGS_TABLE).upsert(linha, { onConflict: 'lead_id' }));
    }
    if (!error) {
      settingsDurable = true;
      settingsMemory.set(leadId, { enabled: Boolean(enabled), updatedAt: agora });
      return { enabled: Boolean(enabled), durable: true };
    }
    settingsDurable = false;
    console.warn('[ia-whatsapp] Não consegui gravar o ajuste no banco; guardei só em memória:', error.message);
  }
  settingsMemory.set(leadId, { enabled: Boolean(enabled), updatedAt: agora });
  return { enabled: Boolean(enabled), durable: false };
}

/* ---------------------------------------------------------------- telefone */

function somenteDigitos(valor) {
  return String(valor || '').replace(/\D/g, '');
}

/* O mesmo celular aparece como 5531999998888, 31999998888 e 3199998888
   (sem o 9º dígito) conforme onde foi cadastrado. Comparar o conjunto de
   variantes evita duplicar lead ou deixar de responder por causa disso. */
function variantes(telefone) {
  const saida = new Set();
  let d = somenteDigitos(telefone);
  if (!d) return saida;
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  saida.add(d);
  if (d.length === 11) saida.add(`${d.slice(0, 2)}${d.slice(3)}`);
  if (d.length === 10) saida.add(`${d.slice(0, 2)}9${d.slice(2)}`);
  return saida;
}

function mesmoTelefone(a, b) {
  const va = variantes(a);
  for (const v of variantes(b)) if (va.has(v)) return true;
  return false;
}

async function leadsPorTelefone() {
  if (Date.now() - phoneCache.at < PHONE_CACHE_MS && phoneCache.leads.length) return phoneCache.leads;
  const leads = await useLeads().list();
  phoneCache = {
    at: Date.now(),
    leads: (leads || [])
      .map((l) => ({ id: l.id, company: l.company || '', whatsapp: l.whatsapp || '', phone: l.phone || '' }))
      .filter((l) => l.whatsapp || l.phone),
  };
  return phoneCache.leads;
}

async function leadDoTelefone(telefone) {
  if (!normalizeWhatsAppPhone(telefone)) return null;
  const leads = await leadsPorTelefone();
  return leads.find((l) => mesmoTelefone(telefone, l.whatsapp) || mesmoTelefone(telefone, l.phone)) || null;
}

/* ---------------------------------------------------------------- sessão */

function novoIdSessao() {
  return `aiw_${crypto.randomUUID()}`;
}

async function sessionParaLead(leadId) {
  const sessoes = await useStore().listSessions(leadId, 10);
  const agora = Date.now();
  const atual = (sessoes || []).find((s) => s
    && (s.channel || 'voz') === 'whatsapp'
    && s.status === 'ativa'
    && agora - (Date.parse(s.startedAt) || 0) < SESSION_MAX_AGE_MS);
  if (atual) return atual;

  /* Sessão velha ainda "ativa" (aba fechada, cliente voltou dias depois) é
     encerrada antes de abrir a nova: o histórico continua, mas cada conversa
     tem começo e fim. */
  for (const antiga of sessoes || []) {
    if (antiga && (antiga.channel || 'voz') === 'whatsapp' && antiga.status === 'ativa') {
      const encerradaEm = new Date().toISOString();
      const inicio = Date.parse(antiga.startedAt) || Date.parse(encerradaEm);
      const mensagens = await useStore().listMessages(antiga.id).catch(() => []);
      const transcricao = (mensagens || [])
        .map((m) => `${m.role === 'user' ? 'Cliente' : config.assistantName}: ${m.content}`)
        .join('\n');
      await useStore().updateSession(antiga.id, {
        status: 'encerrada',
        endedAt: encerradaEm,
        durationSeconds: Math.max(0, Math.round((Date.parse(encerradaEm) - inicio) / 1000)),
        messageCount: (mensagens || []).length,
        transcript: transcricao,
      }).catch(() => {});
    }
  }
  return useStore().createSession({ id: novoIdSessao(), leadId, user: null, channel: 'whatsapp' });
}

/* ---------------------------------------------------------------- fila */

function podeResponder(conversationId) {
  const agora = Date.now();
  const marcas = (replyLog.get(conversationId) || []).filter((t) => agora - t < REPLY_WINDOW_MS);
  replyLog.set(conversationId, marcas);
  return marcas.length < MAX_REPLIES_PER_WINDOW;
}

function registrarResposta(conversationId) {
  const marcas = replyLog.get(conversationId) || [];
  marcas.push(Date.now());
  replyLog.set(conversationId, marcas);
}

/* Chamado pelo provider do WhatsApp logo depois de gravar uma mensagem
   RECEBIDA. Não responde na hora: acumula e espera o cliente terminar de
   digitar, para não virar uma resposta para cada bolha. */
function idJaTratado(id) {
  if (!id) return false;
  const agora = Date.now();
  for (const [chave, quando] of idsTratados) {
    if (agora - quando > ID_TTL_MS) idsTratados.delete(chave);
  }
  if (idsTratados.has(id)) return true;
  idsTratados.set(id, agora);
  return false;
}

function noteIncoming({ conversationId, phone, text, at, messageId }) {
  logIA('recebida', { conversationId, phone, messageId, text: String(text == null ? '' : text).slice(0, 80) });
  if (!config.enabled || !conversationId || !phone) {
    logIA('ignorada', { motivo: !config.enabled ? 'IA desligada' : 'sem conversa/telefone' });
    return;
  }
  const conteudo = String(text == null ? '' : text).trim();
  if (!conteudo || conteudo.startsWith('[')) { logIA('ignorada', { motivo: 'texto vazio ou mídia' }); return; }
  /* Mensagem antiga que o celular entregou depois (offline, histórico) não é
     conversa de agora e não merece resposta automática. */
  const quando = at ? Date.parse(at) : Date.now();
  if (Number.isFinite(quando) && Date.now() - quando > 10 * 60 * 1000) {
    logIA('ignorada', { motivo: 'mensagem com mais de 10 minutos', at });
    return;
  }
  if (idJaTratado(messageId)) {
    logIA('ignorada', { motivo: 'mensagem já enfileirada', messageId });
    return;
  }

  const fila = pending.get(conversationId) || { phone, textos: [], timer: null };
  fila.phone = phone;
  fila.textos.push(conteudo);
  if (fila.textos.length > 8) fila.textos = fila.textos.slice(-8);
  if (fila.timer) clearTimeout(fila.timer);
  fila.timer = setTimeout(() => { flush(conversationId).catch(logFalha); }, DEBOUNCE_MS);
  if (fila.timer.unref) fila.timer.unref();
  pending.set(conversationId, fila);
  logIA('enfileirada', { conversationId, espera: DEBOUNCE_MS, bolhas: fila.textos.length });
}

/* Falha aqui nunca vira mensagem para o cliente — mas precisa aparecer no log,
   senão "a IA não respondeu" fica impossível de diagnosticar. */
function logFalha(error) {
  const mensagem = (error && error.message) || String(error);
  logIA('falha', { erro: mensagem });
  console.warn('[ia-whatsapp] Falha ao responder automaticamente:', mensagem);
}

async function flush(conversationId) {
  if (replying.has(conversationId)) return;
  const fila = pending.get(conversationId);
  if (!fila || !fila.textos.length) return;
  pending.delete(conversationId);
  fila.timer = null;

  replying.add(conversationId);
  try {
    await responder(conversationId, fila.phone, fila.textos);
  } finally {
    replying.delete(conversationId);
    // Chegou mais mensagem enquanto a IA pensava: responde no próximo turno.
    const restante = pending.get(conversationId);
    if (restante && restante.textos.length && !restante.timer) {
      restante.timer = setTimeout(() => { flush(conversationId).catch(logFalha); }, DEBOUNCE_MS);
      if (restante.timer.unref) restante.timer.unref();
    }
  }
}

function prepararResposta(texto) {
  let saida = String(texto || '')
    .replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (saida.length > MAX_REPLY_CHARS) {
    const corte = saida.slice(0, MAX_REPLY_CHARS);
    const ponto = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('! '), corte.lastIndexOf('? '));
    saida = (ponto > MAX_REPLY_CHARS * 0.6 ? corte.slice(0, ponto + 1) : `${corte.trim()}…`);
  }
  return saida;
}

async function responder(conversationId, phone, textos) {
  logIA('processando', { conversationId, phone, textos: textos.length });
  if (!podeResponder(conversationId)) {
    logIA('ignorada', { motivo: 'limite de respostas atingido' });
    console.warn('[ia-whatsapp] Limite de respostas automáticas atingido nesta conversa; a IA fica em silêncio.');
    return;
  }

  const lead = await leadDoTelefone(phone);
  if (!lead) {
    logIA('ignorada', { motivo: 'telefone sem lead cadastrado', phone });
    return;
  }

  const ajuste = await getSetting(lead.id);
  if (!ajuste.enabled) {
    logIA('ignorada', { motivo: 'atendimento automático desligado no lead', leadId: lead.id });
    return;
  }

  const saude = await useLlama().checkHealth();
  if (!saude.available) {
    logIA('ignorada', { motivo: 'motor de IA fora do ar', leadId: lead.id });
    console.warn('[ia-whatsapp] Motor de IA fora do ar; mensagem não respondida.');
    return;
  }
  const whats = await whatsAppStatus().catch(() => null);
  if (!whats || whats.status !== 'CONNECTED') {
    logIA('ignorada', { motivo: 'WhatsApp desconectado', leadId: lead.id, status: whats && whats.status });
    console.warn('[ia-whatsapp] WhatsApp desconectado; mensagem não respondida.');
    return;
  }

  const ctx = await useLeadContext().buildContext(lead.id);
  const sessao = await sessionParaLead(lead.id);
  for (const texto of textos) {
    await useStore().addMessage(sessao.id, { role: 'user', content: texto });
  }

  const historico = await useStore().listMessages(sessao.id);
  const recentes = (historico || []).slice(-16).map((m) => ({ role: m.role, content: m.content }));
  const instrucao = [
    useLeadContext().systemPrompt(),
    '',
    useLeadContext().contextMessage(ctx.text),
    '',
    'Agora você está respondendo pelo WhatsApp do atendimento, como mensagem digitada.',
    'Regras desta resposta: no máximo 3 frases curtas e naturais; sem listas, tabelas ou markdown;',
    'sem emojis em excesso (no máximo um); nunca invente preço, prazo, condição comercial ou dado',
    'que não esteja no contexto; se faltar informação, diga que vai confirmar com a equipe.',
    'Não peça dados sensíveis e não prometa nada em nome do CRM.',
  ].join('\n');

  let resposta;
  try {
    resposta = await useLlama().chat(
      [{ role: 'system', content: instrucao }, ...recentes],
      { maxTokens: 220, temperature: 0.4 }
    );
  } catch (error) {
    throw new Error(`a IA não gerou a resposta (lead ${lead.id}): ${(error && error.message) || error}`);
  }

  const texto = prepararResposta(resposta && resposta.text);
  if (!texto) throw new Error(`a IA devolveu resposta vazia (lead ${lead.id})`);

  await sendWhatsApp(conversationId, texto, `IA ${config.assistantName}`);
  registrarResposta(conversationId);
  await useStore().addMessage(sessao.id, { role: 'assistant', content: texto });
  logIA('enviada', { leadId: lead.id, conversationId, chars: texto.length, sessao: sessao.id });
  console.log(`[ia-whatsapp] Resposta enviada ao lead ${lead.id} (${texto.length} caracteres).`);
}

/* ---------------------------------------------------------------- abordagem */

/* Botão "IA iniciar conversa": a IA escreve e envia a PRIMEIRA mensagem para o
   cliente. Diferente da resposta automática, aqui é uma ação explícita do
   atendente; por isso só vale em conversa nova (sem nenhuma mensagem) e nunca
   é disparada em lote. Se o cliente já escreveu, quem responde é a fila. */
async function startConversation(leadId, user) {
  const lead = await useLeads().getById(leadId);
  if (!lead) throw new ApiError(404, 'Lead não encontrado.');
  const telefone = [lead.whatsapp, lead.phone].map(normalizeWhatsAppPhone).find(Boolean);
  if (!telefone) {
    throw new ApiError(400, 'Este lead não tem WhatsApp nem telefone válido. Preencha o número antes de pedir a abordagem.');
  }

  const ajuste = await getSetting(leadId);
  if (!ajuste.enabled) {
    throw new ApiError(409, 'Ligue o atendimento automático deste lead antes de a IA iniciar a conversa.');
  }

  if (starting.has(leadId)) {
    throw new ApiError(409, 'A IA já está preparando a abordagem deste lead. Aguarde alguns segundos.');
  }

  const saude = await useLlama().checkHealth({ force: true });
  if (!saude.available) {
    throw new ApiError(409, `${saude.detail} Ligue os motores (INICIAR_IA_VOZ.bat) antes de pedir a abordagem.`);
  }
  const whats = await whatsAppStatus().catch((error) => { throw new ApiError(409, error.message || 'WhatsApp indisponível.'); });
  if (!whats || whats.status !== 'CONNECTED') {
    throw new ApiError(409, 'Conecte o WhatsApp no CRM antes de a IA iniciar a conversa.');
  }

  starting.add(leadId);
  try {
    const ctx = await useLeadContext().buildContext(leadId);
    const instrucao = [
      useLeadContext().systemPrompt(),
      '',
      useLeadContext().contextMessage(ctx.text),
      '',
      'Agora você vai INICIAR a conversa no WhatsApp com este lead, porque ainda não existe',
      'nenhuma mensagem entre o atendimento e ele por este canal.',
      'Escreva UMA única mensagem curta (no máximo 3 frases), educada e natural, como uma',
      'pessoa do time comercial digitando. Apresente-se pelo seu nome. Use o nome do contato',
      'e a empresa apenas se estiverem no contexto. Puxe um assunto concreto e leve ligado ao',
      'que o CRM sabe do lead e termine com uma pergunta simples para abrir conversa.',
      'Sem listas ou markdown, no máximo um emoji. Nunca invente preço, prazo, condição ou',
      'promessa; se precisar de algo, diga que a equipe confirma.',
    ].join('\n');

    let resposta;
    try {
      resposta = await useLlama().chat(
        [{ role: 'system', content: instrucao }],
        { maxTokens: 180, temperature: 0.5 }
      );
    } catch (error) {
      throw new ApiError(502, `A IA não gerou a abordagem: ${(error && error.message) || error}`);
    }
    const texto = prepararResposta(resposta && resposta.text);
    if (!texto) throw new ApiError(502, 'A IA devolveu uma abordagem vazia. Tente de novo.');

    /* Só abre a conversa depois de ter texto: uma geração que falha não deixa
       ficha vazia no menu do WhatsApp. O openLeadConversation já resolve o
       número irmão (com/sem o 9º dígito) e devolve as mensagens atuais. */
    const conversa = await openConversation(leadId);
    if (!conversa || !conversa.id) {
      throw new ApiError(502, 'Não consegui abrir a conversa do WhatsApp deste lead.');
    }
    const jaTemMensagens = Array.isArray(conversa.messages) && conversa.messages.length > 0;
    if (jaTemMensagens) {
      throw new ApiError(409, 'Este cliente já tem conversa no WhatsApp. A IA já responde sozinha quando ele escrever; a abordagem inicial só vale para conversa nova.');
    }

    const sessao = await sessionParaLead(leadId);
    await sendWhatsApp(conversa.id, texto, `IA ${config.assistantName}`);
    registrarResposta(conversa.id);
    await useStore().addMessage(sessao.id, { role: 'assistant', content: texto });
    console.log(`[ia-whatsapp] Abordagem inicial enviada ao lead ${leadId} (${texto.length} caracteres).`);
    return {
      leadId,
      conversationId: conversa.id,
      message: texto,
      sentBy: `IA ${config.assistantName}`,
      by: user || null,
    };
  } finally {
    starting.delete(leadId);
  }
}

/* ---------------------------------------------------------------- API */

async function statusForLead(leadId) {
  const lead = await useLeads().getById(leadId);
  if (!lead) throw new ApiError(404, 'Lead não encontrado.');
  const telefone = [lead.whatsapp, lead.phone].map(normalizeWhatsAppPhone).find(Boolean) || '';
  const ajuste = await getSetting(leadId);

  let whats = { connected: false, detail: 'WhatsApp ainda não conectado neste backend.' };
  try {
    const s = await whatsAppStatus();
    whats = {
      connected: s && s.status === 'CONNECTED',
      detail: s && s.status === 'CONNECTED' ? 'WhatsApp conectado.' : 'Conecte o WhatsApp no menu WhatsApp para a IA poder responder.',
    };
  } catch (error) {
    whats = { connected: false, detail: (error && error.message) || 'WhatsApp indisponível neste ambiente.' };
  }

  const saude = await useLlama().checkHealth();
  return {
    leadId,
    enabled: Boolean(ajuste.enabled),
    phone: telefone,
    whatsapp: whats,
    llama: { available: Boolean(saude.available), detail: saude.detail || '' },
    storage: { durable: Boolean(ajuste.durable && settingsDurable) },
    canEnable: Boolean(telefone) && whats.connected && saude.available,
  };
}

async function setEnabled(leadId, enabled, user) {
  const lead = await useLeads().getById(leadId);
  if (!lead) throw new ApiError(404, 'Lead não encontrado.');
  const telefone = [lead.whatsapp, lead.phone].map(normalizeWhatsAppPhone).find(Boolean);
  if (!telefone) {
    throw new ApiError(400, 'Este lead não tem WhatsApp nem telefone válido. Preencha o número antes de ativar o atendimento automático.');
  }

  if (enabled) {
    const saude = await useLlama().checkHealth({ force: true });
    if (!saude.available) {
      throw new ApiError(409, `${saude.detail} Ligue os motores (INICIAR_IA_VOZ.bat) antes de ativar o envio automático.`);
    }
    const whats = await whatsAppStatus().catch((error) => { throw new ApiError(409, error.message || 'WhatsApp indisponível.'); });
    if (!whats || whats.status !== 'CONNECTED') {
      throw new ApiError(409, 'Conecte o WhatsApp no CRM antes de ativar o envio automático — sem conexão a IA não consegue responder.');
    }
  }

  const resultado = await setSetting(leadId, enabled, user || null);
  if (enabled) {
    console.log(`[ia-whatsapp] Atendimento automático ativado para o lead ${leadId}.`);
  }
  return {
    leadId,
    enabled: resultado.enabled,
    durable: resultado.durable,
  };
}

/* Usado pelos testes (e por quem quiser isolar dependências). */
function __setDependencies(overrides) { deps = overrides || null; }
function __reset() {
  deps = null;
  pending.clear();
  replying.clear();
  starting.clear();
  replyLog.clear();
  idsTratados.clear();
  settingsMemory.clear();
  phoneCache = { at: 0, leads: [] };
  settingsDurable = false;
}

module.exports = {
  noteIncoming,
  startConversation,
  statusForLead,
  setEnabled,
  __setDependencies,
  __reset,
  __internos: { mesmoTelefone, variantes, prepararResposta, leadDoTelefone },
};
