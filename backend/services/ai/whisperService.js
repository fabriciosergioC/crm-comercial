'use strict';

/* ===========================================================================
   Reconhecimento de fala com whisper.cpp local.

   Fluxo: o navegador grava um trecho (MediaRecorder) e envia o binário para o
   backend; aqui o áudio é convertido para WAV 16 kHz mono com o ffmpeg-static
   que o CRM já usa no WhatsApp, e só então vai para o servidor whisper.cpp
   (POST /inference, multipart). O áudio NÃO é gravado em disco nem guardado:
   o arquivo temporário mora em memória (pipe do ffmpeg) e morre no fim.
   ========================================================================== */

const { spawn } = require('node:child_process');
const { ApiError } = require('../../middleware/errorHandler');
const config = require('./aiConfig');

const HEALTH_TTL_MS = 5000;
let healthCache = { at: 0, value: null };

function friendlyConnectionMessage(reason) {
  return (
    `O reconhecimento de voz local não respondeu em ${config.whisper.baseUrl}. ` +
    'Abra o scripts/ai/start-ai.ps1 (ou INICIAR_IA_VOZ.bat) e confira o whisper-server. ' +
    `Detalhe: ${reason}`
  );
}

async function checkHealth({ force = false } = {}) {
  if (!config.enabled) {
    return { available: false, model: config.whisper.model, detail: 'Assistente de voz desativado (AI_ENABLED=false).' };
  }
  if (!force && healthCache.value && Date.now() - healthCache.at < HEALTH_TTL_MS) return healthCache.value;

  let value;
  try {
    const res = await fetch(`${config.whisper.baseUrl}/health`, {
      signal: AbortSignal.timeout(config.whisper.healthTimeoutMs),
    });
    value = res.ok
      ? { available: true, model: config.whisper.model, detail: 'whisper.cpp respondendo.' }
      : { available: false, model: config.whisper.model, detail: `O whisper.cpp respondeu HTTP ${res.status}.` };
  } catch (error) {
    const msg = String((error && error.message) || error);
    value = {
      available: false,
      model: config.whisper.model,
      detail: /timeout|abort/i.test(msg)
        ? 'O whisper.cpp demorou para responder ao /health.'
        : 'Nenhum processo escutando na porta do whisper.cpp.',
    };
  }
  healthCache = { at: Date.now(), value };
  return value;
}

/* Converte o áudio do navegador (webm/opus, ogg, mp4…) para WAV PCM 16 bits,
   16 kHz, mono — o formato que o whisper.cpp espera. Tudo por pipe. */
function toWav16k(inputBuffer, mime) {
  return new Promise((resolve, reject) => {
    const isWav = /audio\/(x-)?wav|audio\/wave/i.test(String(mime || ''));
    if (isWav && inputBuffer.length > 44) return resolve(inputBuffer);

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-t', String(config.whisper.maxSeconds),
      '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1',
    ];
    const child = spawn(config.whisper.ffmpegPath, args, { windowsHide: true });
    const out = [];
    let outBytes = 0;
    let errText = '';
    let settled = false;
    const cap = 40 * 1024 * 1024;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) {}
      reject(new ApiError(504, 'A conversão do áudio demorou demais. Tente um trecho mais curto.'));
    }, config.whisper.timeoutMs);

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes <= cap) out.push(chunk);
    });
    child.stderr.on('data', (chunk) => { errText += chunk.toString(); if (errText.length > 1200) errText = errText.slice(-1200); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ApiError(503, `Não foi possível executar o ffmpeg (${config.whisper.ffmpegPath}): ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || outBytes === 0) {
        reject(new ApiError(422, 'Não foi possível converter o áudio gravado. Grave novamente por alguns segundos.'));
        return;
      }
      resolve(Buffer.concat(out));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(inputBuffer);
  });
}

function cleanTranscript(text) {
  let out = String(text == null ? '' : text).trim();
  // Marcadores comuns do Whisper que não são fala.
  out = out.replace(/\[(BLANK_AUDIO|Música|Music|Silêncio|Silence|Inaudível|inaudible|Ruído|Noise)[^\]]*\]/gi, ' ');
  out = out.replace(/\((silêncio|silence|inaudível|inaudible)\)/gi, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

async function transcribe(inputBuffer, mime) {
  if (!config.enabled) throw new ApiError(503, 'O assistente de voz está desativado (AI_ENABLED=false).');
  if (!inputBuffer || !inputBuffer.length) throw new ApiError(400, 'Nenhum áudio recebido.');
  if (inputBuffer.length > config.whisper.maxUploadBytes) {
    throw new ApiError(413, 'O áudio é grande demais. Fale em trechos de até 60 segundos.');
  }

  const wav = await toWav16k(inputBuffer, mime);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0.0');
  form.append('temperature_inc', '0.2');
  form.append('language', config.whisper.language);
  // Contexto curto em português ajuda nomes e palavras comerciais.
  form.append('prompt', 'Atendimento comercial em português do Brasil.');

  let res;
  try {
    res = await fetch(`${config.whisper.baseUrl}${config.whisper.inferencePath}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(config.whisper.timeoutMs),
    });
  } catch (error) {
    const msg = String((error && error.message) || error);
    throw new ApiError(503, friendlyConnectionMessage(/timeout|abort/i.test(msg) ? 'tempo esgotado' : msg));
  }

  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
  if (!res.ok) {
    throw new ApiError(502, 'O whisper.cpp recusou o áudio enviado (HTTP ' + res.status + ').');
  }

  // A resposta pode vir { text } ou uma lista [{ text }] em versões antigas.
  let text = '';
  if (data && typeof data.text === 'string') text = data.text;
  else if (Array.isArray(data)) text = data.map((item) => (item && item.text) || '').join(' ');

  const transcript = cleanTranscript(text);
  if (!transcript) {
    throw new ApiError(422, 'Não consegui entender o áudio. Fale um pouco mais perto do microfone e tente de novo.');
  }
  return transcript;
}

function resetHealthCache() {
  healthCache = { at: 0, value: null };
}

module.exports = { checkHealth, transcribe, cleanTranscript, resetHealthCache, config };
