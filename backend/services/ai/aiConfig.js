'use strict';

/* ===========================================================================
   Configuração da IA do CRM.

   Texto do WhatsApp  -> llama.cpp em 127.0.0.1:8080 (local, sem chave).
   Áudio do WhatsApp  -> whisper.cpp em 127.0.0.1:8081 (transcrição).
   Ligação para lead  -> LiveKit Cloud (WebRTC no navegador) + agente opcional.
   TTS local/Piper foi removido junto com o painel de voz do CRM.

   Nenhuma credencial mora aqui: o front nunca recebe caminho de arquivo, URL
   interna sensível nem chave do LiveKit.
   ========================================================================== */

const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

function envText(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  return String(raw).trim();
}

function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function envFloat(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/* Caminho relativo à raiz do projeto (é de lá que o run-crm.bat roda). */
function projectPath(value) {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

const AI_HOME = projectPath(envText('AI_HOME', path.join('tools', 'ai')));

/* URL local nunca deve ir para a rede: se alguém configurar 0.0.0.0 por engano,
   o backend continua falando com 127.0.0.1. O llama.cpp/whisper.cpp devem
   subir com --host 127.0.0.1 (ver scripts/ai/start-ai.ps1). */
function localBaseUrl(value, fallback) {
  const raw = value || fallback;
  return String(raw).replace(/\/+$/, '');
}

const config = {
  enabled: envBool('AI_ENABLED', true),
  assistantName: envText('AI_ASSISTANT_NAME', 'Sofia'),
  /* A empresa/agência não é inventada: o prompt usa este nome apenas se
     configurado; caso contrário fala "nossa equipe". */
  companyName: envText('AI_COMPANY_NAME', ''),

  llama: {
    baseUrl: localBaseUrl(process.env.LLAMA_BASE_URL, 'http://127.0.0.1:8080'),
    model: envText('LLAMA_MODEL', 'qwen2.5-1.5b-instruct'),
    timeoutMs: envInt('LLAMA_TIMEOUT_MS', 120000, 5000, 600000),
    healthTimeoutMs: envInt('LLAMA_HEALTH_TIMEOUT_MS', 2500, 300, 30000),
    temperature: envFloat('AI_TEMPERATURE', 0.6, 0, 1.5),
    topP: envFloat('AI_TOP_P', 0.9, 0.1, 1),
    maxOutputTokens: envInt('AI_MAX_OUTPUT_TOKENS', 220, 40, 800),
    contextTokens: envInt('AI_CONTEXT_TOKENS', 2048, 512, 8192),
    historyMaxMessages: envInt('AI_HISTORY_MAX_MESSAGES', 16, 4, 60),
    historyMaxChars: envInt('AI_HISTORY_MAX_CHARS', 5000, 800, 20000),
  },

  whisper: {
    baseUrl: localBaseUrl(process.env.WHISPER_BASE_URL, 'http://127.0.0.1:8081'),
    inferencePath: envText('WHISPER_INFERENCE_PATH', '/inference'),
    healthTimeoutMs: envInt('WHISPER_HEALTH_TIMEOUT_MS', 2000, 300, 30000),
    timeoutMs: envInt('WHISPER_TIMEOUT_MS', 120000, 5000, 600000),
    language: envText('WHISPER_LANGUAGE', 'pt'),
    model: envText('WHISPER_MODEL', 'ggml-small.bin'),
    /* O navegador manda webm/opus; o ffmpeg-static já é dependência do CRM. */
    maxUploadBytes: envInt('AI_AUDIO_MAX_BYTES', 12 * 1024 * 1024, 256 * 1024, 30 * 1024 * 1024),
    maxSeconds: envInt('AI_AUDIO_MAX_SECONDS', 60, 5, 180),
    ffmpegPath: envText('AI_FFMPEG_PATH', '') || (() => {
      try { return require('ffmpeg-static'); } catch (_) { return 'ffmpeg'; }
    })(),
  },

  /* LiveKit Cloud: ligação pelo navegador (o lead recebe um link). O plano
     gratuito cobre minutos de WebRTC e de agente; telefone comum (PSTN) não. */
  livekit: {
    url: envText('LIVEKIT_URL', ''),
    apiKey: envText('LIVEKIT_API_KEY', ''),
    apiSecret: envText('LIVEKIT_API_SECRET', ''),
    /* Nome do agente publicado no LiveKit Cloud. Vazio = só navegador<->navegador. */
    agentName: envText('LIVEKIT_AGENT_NAME', ''),
    /* Endereço público do CRM, usado no link enviado ao lead. Vazio = usa o
       host da própria requisição (funciona em localhost e no Railway/ngrok). */
    publicBaseUrl: envText('PUBLIC_BASE_URL', ''),
    tokenTtlMinutes: envInt('LIVEKIT_TOKEN_TTL_MIN', 240, 15, 1440),
  },

  storage: {
    /* auto: usa as tabelas se a migration 016 já foi aplicada; senão memória,
       avisando na tela. db | memory para forçar. */
    mode: envText('AI_STORAGE', 'auto').toLowerCase(),
    sessionsPerLead: envInt('AI_HISTORY_SESSIONS', 20, 1, 100),
    memorySessions: envInt('AI_MEMORY_SESSIONS', 60, 5, 500),
  },

  limits: {
    maxUserChars: envInt('AI_USER_MAX_CHARS', 1000, 100, 5000),
    /* Atraso que junta mensagens seguidas do cliente em uma resposta só. */
    whatsappAutoDelayMs: envInt('AI_WHATSAPP_DELAY_MS', 2500, 200, 15000),
    whatsappAutoMaxReplies: envInt('AI_WHATSAPP_MAX_REPLIES', 8, 1, 50),
  },

  aiHome: AI_HOME,
  projectRoot: PROJECT_ROOT,
};

module.exports = config;
