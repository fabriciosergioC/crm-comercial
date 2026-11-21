'use strict';

/* ===========================================================================
   Cliente do llama.cpp (API HTTP compatível com OpenAI).

   Endpoint usado: POST {LLAMA_BASE_URL}/v1/chat/completions
   - sem streaming: o texto volta inteiro e é enviado ao WhatsApp; streaming
     só atrapalharia o desenho da resposta na tela.
   - UMA requisição por vez: o modelo de 1.5B roda na CPU e concorrência
     paralela só aumenta a latência de todo mundo. A fila é global.
   - o modelo devolve texto; nada de chave de API, nada de sair da máquina.
   ========================================================================== */

const { ApiError } = require('../../middleware/errorHandler');
const config = require('./aiConfig');

const HEALTH_TTL_MS = 5000;
let healthCache = { at: 0, value: null };
let queue = Promise.resolve();

function withQueue(task) {
  const run = queue.then(task, task);
  // A fila não pode morrer por causa de um erro de uma requisição.
  queue = run.catch(() => {});
  return run;
}

function friendlyConnectionMessage(reason) {
  return (
    `O servidor de IA local não respondeu em ${config.llama.baseUrl}. ` +
    'Abra o scripts/ai/start-ai.ps1 (ou INICIAR_IA_VOZ.bat) e confira o llama-server ' +
    `na porta configurada. Detalhe: ${reason}`
  );
}

/* GET /health do llama.cpp. Cache curto para a tela poder consultar o status
   sem martelar o servidor a cada render. */
async function checkHealth({ force = false } = {}) {
  if (!config.enabled) {
    return { available: false, model: config.llama.model, detail: 'Assistente de voz desativado (AI_ENABLED=false).' };
  }
  if (!force && healthCache.value && Date.now() - healthCache.at < HEALTH_TTL_MS) {
    return healthCache.value;
  }
  let value;
  try {
    const res = await fetch(`${config.llama.baseUrl}/health`, {
      signal: AbortSignal.timeout(config.llama.healthTimeoutMs),
    });
    if (!res.ok) {
      value = { available: false, model: config.llama.model, detail: `O llama.cpp respondeu HTTP ${res.status}.` };
    } else {
      value = { available: true, model: config.llama.model, detail: 'llama.cpp respondendo.' };
    }
  } catch (error) {
    const msg = String((error && error.message) || error);
    value = {
      available: false,
      model: config.llama.model,
      detail: /timeout|abort/i.test(msg)
        ? 'O llama.cpp demorou para responder ao /health.'
        : 'Nenhum processo escutando na porta do llama.cpp.',
    };
  }
  healthCache = { at: Date.now(), value };
  return value;
}

/* Limpa o que o modelo às vezes devolve e não deve virar fala nem poluir a
   bolha de conversa: bloco de raciocínio, marcação markdown, emojis. */
function sanitizeReply(raw) {
  let text = String(raw == null ? '' : raw);
  text = text.replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, ' ');
  text = text.replace(/<\|[^|>]*\|>/g, ' ');
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/[*_`#>]+/g, '');
  text = text.replace(/\[([^\]]{0,40})\]/g, ' ');
  text = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ');
  text = text.replace(/\r/g, '');
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text.slice(0, 1600);
}

/* Mensagens: [{ role, content }]. O histórico já vem cortado pelo serviço que
   chamou (WhatsApp automático ou agente de ligação); aqui só garantimos o
   mínimo. */
async function chat(messages, options = {}) {
  if (!config.enabled) throw new ApiError(503, 'A IA está desativada (AI_ENABLED=false).');
  const list = Array.isArray(messages) ? messages.filter((m) => m && m.content) : [];
  if (!list.length) throw new ApiError(400, 'Nenhuma mensagem para enviar à IA.');

  const timeoutMs = options.timeoutMs || config.llama.timeoutMs;
  const body = {
    model: config.llama.model,
    messages: list.map((m) => ({ role: m.role, content: String(m.content) })),
    temperature: options.temperature !== undefined ? options.temperature : config.llama.temperature,
    top_p: config.llama.topP,
    max_tokens: options.maxTokens || config.llama.maxOutputTokens,
    stream: false,
    cache_prompt: true,
  };

  return withQueue(async () => {
    let res;
    try {
      res = await fetch(`${config.llama.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const msg = String((error && error.message) || error);
      throw new ApiError(503, friendlyConnectionMessage(/timeout|abort/i.test(msg) ? 'tempo esgotado' : msg));
    }

    const rawText = await res.text();
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch (_) { data = null; }

    if (!res.ok) {
      const detail = (data && data.error && (data.error.message || data.error.code)) || `HTTP ${res.status}`;
      throw new ApiError(502, `O servidor llama.cpp recusou o pedido: ${detail}`);
    }
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const content = choice && choice.message ? choice.message.content : '';
    const text = sanitizeReply(content);
    if (!text) throw new ApiError(502, 'O modelo não devolveu texto nesta resposta. Tente novamente.');
    return {
      text,
      usage: (data && data.usage) || null,
      model: (data && data.model) || config.llama.model,
    };
  });
}

function resetHealthCache() {
  healthCache = { at: 0, value: null };
}

module.exports = { checkHealth, chat, sanitizeReply, resetHealthCache, config };
