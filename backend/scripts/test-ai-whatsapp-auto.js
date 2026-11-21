'use strict';

/* ===========================================================================
   Teste da resposta automática da IA no WhatsApp.

   Não usa WhatsApp real, llama real nem Supabase: injeta dependências falsas
   no serviço (leads, contexto, motor e envio) e exercita também as rotas
   /api/ai/whatsapp-auto com o store em memória (AI_STORAGE=memory).

   Uso (da pasta backend):
     node scripts/test-ai-whatsapp-auto.js
   ========================================================================== */

process.env.AI_STORAGE = 'memory';
process.env.AI_ENABLED = 'true';
process.env.AI_ASSISTANT_NAME = 'Sofia';
process.env.AI_WHATSAPP_DELAY_MS = '60';
process.env.AI_WHATSAPP_MAX_REPLIES = '3';

const http = require('node:http');
const express = require('express');
const auto = require('../services/ai/whatsappAutoReply');
const store = require('../services/ai/aiSessionsStore');

let passos = 0;
let falhas = 0;

function ok(cond, mensagem, extra) {
  if (!cond) { falhas += 1; console.error(`  FALHOU  ${mensagem}${extra ? ` — ${extra}` : ''}`); return; }
  passos += 1;
  console.log(`  ok  ${mensagem}`);
}

function igual(real, esperado, mensagem) {
  ok(real === esperado, mensagem, `recebido ${JSON.stringify(real)}, esperado ${JSON.stringify(esperado)}`);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const LEAD = {
  id: 'l_teste_auto',
  company: 'Clínica Bem Viver',
  contactName: 'Dra. Helena Prado',
  phone: '(31) 99888-7777',
  whatsapp: '(31) 99888-7777',
};
const LEAD_SEM_TELEFONE = { id: 'l_sem_fone', company: 'Sem Fone', contactName: '', phone: '', whatsapp: '' };

const enviados = [];
let llamaOk = true;
let categoriaWhats = 'CONNECTED';
let conversaInicial = { id: 'conv_nova', messages: [] };

function fakeLeads() {
  return {
    async list() { return [LEAD, LEAD_SEM_TELEFONE]; },
    async getById(id) {
      if (id === LEAD.id) return LEAD;
      if (id === LEAD_SEM_TELEFONE.id) return LEAD_SEM_TELEFONE;
      const erro = new Error('Lead não encontrado.');
      erro.status = 404;
      throw erro;
    },
  };
}

function montarDeps() {
  return {
    store,
    leads: fakeLeads(),
    leadContext: {
      async buildContext() { return { text: 'Empresa: Clínica Bem Viver. Contato: Dra. Helena. Temperatura: Morno.', lead: LEAD }; },
      systemPrompt() { return 'Você é a Sofia, assistente comercial educada e objetiva.'; },
      contextMessage(texto) { return texto; },
    },
    llama: {
      async checkHealth() { return { available: llamaOk, detail: llamaOk ? 'ok' : 'motor fora do ar' }; },
      async chat(mensagens) {
        const falas = mensagens.filter((m) => m.role === 'user').map((m) => m.content).join(' | ');
        return { text: `**Certo!** Consigo ajudar. # Observação\nFalas: ${falas}` };
      },
    },
    async whatsAppStatus() { return { status: categoriaWhats }; },
    async sendText(id, content, sentBy) { enviados.push({ id, content, sentBy }); return { id: 'wa_1' }; },
    async openConversation() { return conversaInicial; },
  };
}

async function abrirServidor(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', router);
  app.use(require('../middleware/errorHandler').errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function chamar(base, rota, options) {
  const r = await fetch(base + rota, options);
  let data = null;
  try { data = await r.json(); } catch (_) { data = null; }
  return { status: r.status, data };
}

(async () => {
  console.log('==> Serviço de resposta automática');

  auto.__reset();
  auto.__setDependencies(montarDeps());

  const inicial = await auto.statusForLead(LEAD.id);
  igual(inicial.enabled, false, 'começa desligado');
  igual(inicial.canEnable, true, 'pode ativar com telefone, WhatsApp e motor no ar');
  ok(inicial.phone.endsWith('998887777'), 'telefone do lead é reconhecido', inicial.phone);

  auto.noteIncoming({ conversationId: 'c1', phone: '5531998887777', text: 'Oi, tudo bem?', at: new Date().toISOString() });
  await espera(200);
  igual(enviados.length, 0, 'desligado: mensagem recebida não gera resposta');

  llamaOk = false;
  let bloqueio = null;
  try { await auto.setEnabled(LEAD.id, true); } catch (e) { bloqueio = e; }
  igual(bloqueio && bloqueio.status, 409, 'não ativa com o motor de IA fora do ar');
  llamaOk = true;

  categoriaWhats = 'DISCONNECTED';
  bloqueio = null;
  try { await auto.setEnabled(LEAD.id, true); } catch (e) { bloqueio = e; }
  igual(bloqueio && bloqueio.status, 409, 'não ativa com o WhatsApp desconectado');
  categoriaWhats = 'CONNECTED';

  bloqueio = null;
  try { await auto.setEnabled(LEAD_SEM_TELEFONE.id, true); } catch (e) { bloqueio = e; }
  igual(bloqueio && bloqueio.status, 400, 'não ativa lead sem número');

  const ligado = await auto.setEnabled(LEAD.id, true);
  igual(ligado.enabled, true, 'ativa a opção para o lead');
  igual(ligado.durable, false, 'sem migration, a opção fica em memória (avisa, não finge)');

  auto.noteIncoming({ conversationId: 'c1', phone: '5531998887777', text: 'Quanto custa o site?', at: new Date().toISOString() });
  auto.noteIncoming({ conversationId: 'c1', phone: '5531998887777', text: 'E em quantos dias fica pronto?', at: new Date().toISOString() });
  await espera(300);
  igual(enviados.length, 1, 'duas mensagens seguidas viram UMA resposta');
  ok(/Quanto custa o site\?/.test(enviados[0].content), 'a resposta enxerga a primeira mensagem');
  ok(/quantos dias fica pronto/.test(enviados[0].content), 'a resposta enxerga a segunda mensagem');
  igual(enviados[0].sentBy, 'IA Sofia', 'a mensagem sai identificada como IA');
  ok(!/\*\*|^#/m.test(enviados[0].content), 'markdown é limpo antes do envio');

  auto.noteIncoming({ conversationId: 'c1', phone: '5531998887777', text: 'Perfeito, obrigado.', at: new Date().toISOString() });
  await espera(200);
  igual(enviados.length, 2, 'segunda resposta automática sai normalmente');

  auto.noteIncoming({ conversationId: 'c1', phone: '5531998887777', text: 'Terceira?', at: new Date().toISOString() });
  await espera(200);
  igual(enviados.length, 3, 'terceira resposta ainda dentro do limite');

  auto.noteIncoming({ conversationId: 'c1', phone: '5531998887777', text: 'Quarta?', at: new Date().toISOString() });
  await espera(200);
  igual(enviados.length, 3, 'limite de respostas por conversa segura mensagens em excesso');

  const sessoes = await store.listSessions(LEAD.id, 10);
  const sessaoWa = sessoes.find((s) => s.channel === 'whatsapp');
  ok(Boolean(sessaoWa), 'a conversa automática tem sessão própria no histórico');
  igual(sessaoWa.channel, 'whatsapp', 'sessão marcada como WhatsApp');
  const mensagens = await store.listMessages(sessaoWa.id);
  igual(mensagens.filter((m) => m.role === 'user').length, 4, 'as falas recebidas do cliente ficaram registradas');
  igual(mensagens.filter((m) => m.role === 'assistant').length, 3, 'as respostas enviadas ficaram registradas');

  auto.__reset();
  auto.__setDependencies(montarDeps());
  await auto.setEnabled(LEAD.id, true);
  enviados.length = 0;

  /* O WhatsApp pode entregar a mesma mensagem duas vezes (lote de histórico +
     aviso ao vivo). Deve gerar UMA resposta só. */
  auto.noteIncoming({ conversationId: 'c1', phone: '5531998887777', text: 'Mesma mensagem', at: new Date().toISOString(), messageId: 'msg_repetida' });
  auto.noteIncoming({ conversationId: 'c1', phone: '5531998887777', text: 'Mesma mensagem', at: new Date().toISOString(), messageId: 'msg_repetida' });
  await espera(300);
  igual(enviados.length, 1, 'a mesma mensagem entregue duas vezes gera UMA resposta');
  enviados.length = 0;

  auto.noteIncoming({ conversationId: 'c1', phone: '5531998887777', text: 'Mensagem antiga', at: new Date(Date.now() - 30 * 60 * 1000).toISOString() });
  await espera(200);
  igual(enviados.length, 0, 'mensagem antiga entregue atrasada não é respondida');

  auto.noteIncoming({ conversationId: 'c1', phone: '5531998887777', text: '[Áudio]', at: new Date().toISOString() });
  await espera(200);
  igual(enviados.length, 0, 'áudio/mídia sem texto não é respondido');

  auto.noteIncoming({ conversationId: 'c2', phone: '5531000000000', text: 'Número sem lead', at: new Date().toISOString() });
  await espera(200);
  igual(enviados.length, 0, 'número que não é de lead fica em silêncio');

  await auto.setEnabled(LEAD.id, false);
  auto.noteIncoming({ conversationId: 'c1', phone: '5531998887777', text: 'Desligado agora', at: new Date().toISOString() });
  await espera(200);
  igual(enviados.length, 0, 'desligar volta a silenciar o número');

  console.log('\n==> Abordagem inicial (IA inicia a conversa)');
  auto.__reset();
  auto.__setDependencies(montarDeps());
  enviados.length = 0;
  conversaInicial = { id: 'conv_nova', messages: [] };

  let bloqueioAbordagem = null;
  try { await auto.startConversation(LEAD.id); } catch (e) { bloqueioAbordagem = e; }
  igual(bloqueioAbordagem && bloqueioAbordagem.status, 409, 'não inicia conversa com a opção desligada');

  await auto.setEnabled(LEAD.id, true);

  llamaOk = false;
  bloqueioAbordagem = null;
  try { await auto.startConversation(LEAD.id); } catch (e) { bloqueioAbordagem = e; }
  igual(bloqueioAbordagem && bloqueioAbordagem.status, 409, 'não inicia conversa com o motor fora do ar');
  llamaOk = true;

  categoriaWhats = 'DISCONNECTED';
  bloqueioAbordagem = null;
  try { await auto.startConversation(LEAD.id); } catch (e) { bloqueioAbordagem = e; }
  igual(bloqueioAbordagem && bloqueioAbordagem.status, 409, 'não inicia conversa com o WhatsApp desconectado');
  categoriaWhats = 'CONNECTED';

  bloqueioAbordagem = null;
  try { await auto.startConversation(LEAD_SEM_TELEFONE.id); } catch (e) { bloqueioAbordagem = e; }
  igual(bloqueioAbordagem && bloqueioAbordagem.status, 400, 'não inicia conversa com lead sem número');

  const abordagem = await auto.startConversation(LEAD.id, 'fabricio');
  igual(enviados.length, 1, 'a abordagem inicial é enviada uma única vez');
  igual(enviados[0].id, 'conv_nova', 'a abordagem usa a conversa aberta do lead');
  igual(enviados[0].sentBy, 'IA Sofia', 'a abordagem sai identificada como IA');
  ok(enviados[0].content && enviados[0].content === abordagem.message, 'a resposta devolve o texto realmente enviado', abordagem.message);
  ok(!/\*\*|^#/m.test(abordagem.message), 'a abordagem também é limpa de markdown');

  conversaInicial = { id: 'conv_nova', messages: [{ id: 'm1', direction: 'incoming', content: 'Oi', timestamp: new Date().toISOString() }] };
  enviados.length = 0;
  bloqueioAbordagem = null;
  try { await auto.startConversation(LEAD.id); } catch (e) { bloqueioAbordagem = e; }
  igual(bloqueioAbordagem && bloqueioAbordagem.status, 409, 'não manda abordagem em conversa que já tem mensagens');
  igual(enviados.length, 0, 'conversa existente não recebe abordagem');

  await auto.setEnabled(LEAD.id, false);

  console.log('\n==> Rotas /api/ai/whatsapp-auto');
  const router = require('../routes/aiRoutes');
  const { server, base } = await abrirServidor(router);
  try {
    const status = await chamar(base, `/api/ai/whatsapp-auto/${LEAD.id}`);
    igual(status.status, 200, 'GET devolve o estado da opção');
    igual(status.data.data.enabled, false, 'GET confirma desligado');

    const ativar = await chamar(base, `/api/ai/whatsapp-auto/${LEAD.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, user: 'Fabricio' }),
    });
    igual(ativar.status, 200, 'PUT ativa a opção');
    igual(ativar.data.data.enabled, true, 'PUT devolve enabled = true');

    conversaInicial = { id: 'conv_rota', messages: [] };
    enviados.length = 0;
    const abordar = await chamar(base, `/api/ai/whatsapp-auto/${LEAD.id}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'fabricio' }),
    });
    igual(abordar.status, 201, 'POST /start envia a abordagem inicial');
    ok(abordar.data.data.message && enviados.length === 1, 'POST /start devolve o texto enviado');
    igual(enviados[0].id, 'conv_rota', 'POST /start usa a conversa do lead');

    const semCorpo = await chamar(base, `/api/ai/whatsapp-auto/${LEAD.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ligado: true }),
    });
    igual(semCorpo.status, 400, 'campo desconhecido é recusado');

    enviados.length = 0;
    await chamar(base, `/api/ai/whatsapp-auto/${LEAD.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    auto.noteIncoming({ conversationId: 'c1', phone: '5531998887777', text: 'Depois do PUT', at: new Date().toISOString() });
    await espera(200);
    igual(enviados.length, 0, 'PUT enabled=false volta a silenciar');
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log(`\n${falhas ? `${falhas} falha(s), ${passos} verificações passaram.` : `${passos} verificações passaram.`}`);
  process.exit(falhas ? 1 : 0);
})().catch((error) => {
  console.error('\nERRO NO TESTE:', error && (error.stack || error.message || error));
  process.exit(1);
});
