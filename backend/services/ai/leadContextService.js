'use strict';

/* ===========================================================================
   Contexto do lead para a IA.

   A IA recebe SÓ o que interessa para conversar sobre aquele atendimento:
   cadastro, etapa do funil, histórico de contatos, follow-ups, propostas e,
   se houver, o contrato do cliente. Nada de tabelas inteiras, nada de outros
   leads, nada de credenciais.
   ========================================================================== */

const leadsService = require('../leadsService');
const interactionsService = require('../interactionsService');
const followupsService = require('../followupsService');
const proposalsService = require('../proposalsService');
const clientsService = require('../clientsService');
const config = require('./aiConfig');

const MAX_NOTE = 180;
const MAX_TEXT = 7000;

function clean(value, limit = MAX_NOTE) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function datePtBr(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return clean(value, 50);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function addLine(lines, label, value, limit) {
  const text = clean(value, limit || MAX_NOTE);
  if (text) lines.push(`- ${label}: ${text}`);
}

async function safe(label, fn, warnings) {
  try {
    return await fn();
  } catch (error) {
    warnings.push(`${label}: ${clean(error && error.message, 140)}`);
    return null;
  }
}

async function buildContext(leadId) {
  if (!leadId) throw new Error('leadId obrigatório');
  const warnings = [];
  const lead = await leadsService.getById(leadId);

  const [interactions, followups, proposals, clients] = await Promise.all([
    safe('histórico de contatos', () => interactionsService.list({ leadId, limit: 8 }), warnings),
    safe('follow-ups', () => followupsService.list({ leadId, limit: 6 }), warnings),
    safe('propostas', () => proposalsService.list({ leadId, limit: 4 }), warnings),
    safe('clientes', () => clientsService.list({ leadId, limit: 1 }), warnings),
  ]);

  const lines = [];
  lines.push(`Lead: ${clean(lead.company) || clean(lead.contactName) || 'sem nome'}`);
  addLine(lines, 'Pessoa de contato', lead.contactName, 120);
  addLine(lines, 'Telefone', lead.phone, 40);
  addLine(lines, 'WhatsApp', lead.whatsapp, 40);
  addLine(lines, 'Cidade/bairro', [lead.city, lead.neighborhood].filter(Boolean).join(' / '), 120);
  addLine(lines, 'Segmento', lead.segment, 60);
  addLine(lines, 'Origem', lead.source, 60);
  addLine(lines, 'Status no funil', lead.status, 60);
  addLine(lines, 'Temperatura', lead.temperature, 30);
  addLine(lines, 'Prioridade', lead.priority, 30);
  addLine(lines, 'Responsável', lead.owner, 60);
  addLine(lines, 'Último contato', datePtBr(lead.lastContactAt), 40);
  addLine(lines, 'Cadastrado em', datePtBr(lead.createdAt), 40);
  if (lead.nextAction && (lead.nextAction.date || lead.nextAction.note)) {
    const when = datePtBr(lead.nextAction.date);
    const note = clean(lead.nextAction.note, 160);
    addLine(lines, 'Próxima ação', [when, note].filter(Boolean).join(' — '), 200);
  }
  if (lead.score) {
    const s = lead.score;
    lines.push(`- Score comercial: dor ${s.dor || 0}/5, facilidade ${s.facilidade || 0}/5, pagamento ${s.pagamento || 0}/5, recorrência ${s.recorrencia || 0}/5`);
  }
  addLine(lines, 'Observações do cadastro', lead.notes, 400);

  if (Array.isArray(interactions) && interactions.length) {
    lines.push('Histórico de contatos (mais recentes primeiro):');
    for (const i of interactions) {
      const parts = [datePtBr(i.date), i.channel, i.result].filter(Boolean).join(' · ');
      lines.push(`- ${parts}${i.note ? ` — ${clean(i.note, 160)}` : ''}`);
    }
  }

  if (Array.isArray(followups) && followups.length) {
    lines.push('Follow-ups:');
    for (const f of followups) {
      lines.push(`- ${datePtBr(f.dueDate)} · ${f.status || 'pendente'}${f.note ? ` — ${clean(f.note, 140)}` : ''}`);
    }
  }

  if (Array.isArray(proposals) && proposals.length) {
    lines.push('Propostas:');
    for (const p of proposals) {
      const values = [
        money(p.implementationValue) ? `implantação ${money(p.implementationValue)}` : '',
        money(p.monthlyValue) ? `mensalidade ${money(p.monthlyValue)}` : '',
      ].filter(Boolean).join(', ');
      lines.push(`- ${clean(p.plan, 60)} · ${p.status || ''}${values ? ` · ${values}` : ''}${p.validUntil ? ` · válida até ${datePtBr(p.validUntil)}` : ''}`);
    }
  }

  const client = Array.isArray(clients) && clients.length ? clients[0] : null;
  if (client) {
    lines.push('Cliente já convertido:');
    addLine(lines, 'Plano', client.plan, 60);
    addLine(lines, 'Valor contratado', money(client.contractedValue), 40);
    addLine(lines, 'Mensalidade', money(client.monthlyValue), 40);
    addLine(lines, 'Situação', client.status, 40);
  }

  let text = lines.join('\n');
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n(contexto truncado)';
  return { lead, text, warnings };
}

function systemPrompt() {
  const name = config.assistantName;
  const company = config.companyName ? ` da ${config.companyName}` : '';
  return [
    `Você é ${name}, assistente comercial${company}, do time de vendas.`,
    'Sua voz é feminina, educada, natural, consultiva, objetiva e profissional.',
    'Você conversa por voz com o vendedor responsável pelo lead. O cliente NÃO está na linha:',
    'quem fala com você é o atendente humano, e você ajuda a preparar e conduzir o atendimento.',
    '',
    'REGRA DE OURO: use SOMENTE os dados do lead fornecidos no contexto.',
    'Nunca invente nome, telefone, empresa, produto, preço, prazo, desconto ou condição comercial.',
    'Se a informação não estiver no contexto, diga claramente que não tem essa informação no CRM.',
    'Nunca diga que enviou mensagem, ligou, alterou cadastro ou fechou negócio: você não executa ações.',
    'Quando o atendente pedir uma ação no CRM, responda que ele precisa fazer a alteração na tela.',
    '',
    'Estilo: português do Brasil, no máximo 3 frases curtas por resposta.',
    'Texto puro: sem markdown, sem listas, sem emojis, sem asteriscos — a resposta vai virar áudio.',
    'Faça uma pergunta de avanço por vez (dor, urgência, orçamento, próximo passo) sem ser insistente.',
    'Se o atendente pedir para resumir o lead, resuma em duas frases com os dados reais do contexto.',
  ].join('\n');
}

function contextMessage(contextText) {
  return `DADOS DO LEAD NO CRM (fonte única de verdade):\n${contextText}`;
}

function greetingInstruction(lead) {
  const quem = lead.company || lead.contactName || 'este lead';
  return (
    `Cumprimente o atendente em uma única frase curta (até 25 palavras) e diga que está pronta ` +
    `para ajudar no atendimento de ${quem}. Não invente nenhuma informação e não faça mais de uma pergunta.`
  );
}

function fallbackGreeting(lead) {
  const quem = lead.company || lead.contactName || 'este lead';
  return `Olá! Sou a ${config.assistantName}, assistente comercial. Estou com os dados de ${quem} aqui. Como posso ajudar no atendimento?`;
}

module.exports = { buildContext, systemPrompt, contextMessage, greetingInstruction, fallbackGreeting };
