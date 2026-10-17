"use strict";

/* Áudio que o CLIENTE manda no WhatsApp.
   ----------------------------------------------------------------------------
   Antes deste arquivo a mensagem de voz entrava na tela só como "[Áudio]": sem
   arquivo guardado e sem texto, então ninguém ouvia nada pelo CRM e a IA
   sugeria resposta sem saber o que o cliente falou.

   Hoje, ao receber um audioMessage do Baileys:
     1) o áudio é baixado e gravado no Supabase Storage (bucket privado);
     2) a Groq transcreve (o mesmo chave/free tier da IA de sugestões);
     3) o texto da mensagem no banco vira MARCADOR + transcrição, e é isso que
        aparece na bolha, na prévia da lista e no contexto da IA.

   Nada de coluna nova: o caminho do arquivo no Storage é derivado de
   (conversa, mensagem), então saber que a mensagem tem áudio é só olhar o
   começo do conteúdo. */

const { supabase } = require("../../config/supabase");
const { ApiError } = require("../../middleware/errorHandler");

/* Prefixo que marca "esta mensagem é um áudio do cliente". Ele fica no conteúdo
   gravado porque é a única pista que o chat e a IA precisam. */
const AUDIO_MARKER = "🎧 ";
const SEM_TRANSCRICAO = "[Áudio do cliente — transcrição indisponível]";

/* Limite da Groq para transcrição é 26 MB; áudio de WhatsApp costuma ter
   centenas de KB, então o teto acima já é rede de segurança. */
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

function bucketName() {
  return String(process.env.SUPABASE_AUDIO_BUCKET || "whatsapp-audio").trim() || "whatsapp-audio";
}

function whisperModel() {
  return String(process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo").trim();
}

function signedUrlTtl() {
  const raw = Number(process.env.SUPABASE_AUDIO_URL_TTL || 3600);
  return Number.isFinite(raw) && raw >= 60 && raw <= 86400 ? Math.round(raw) : 3600;
}

/* Ids do Baileys trazem &, = e outros sinais que não combinam com caminho de
   storage. Fica só o que é seguro, mantendo o id reconhecível. */
function safeSegment(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

function objectPath(conversationId, messageId) {
  return `${safeSegment(conversationId)}/${safeSegment(messageId)}.ogg`;
}

function isAudioContent(content) {
  return typeof content === "string" && content.startsWith(AUDIO_MARKER);
}

function transcriptContent(transcript) {
  const texto = String(transcript || "").trim();
  return AUDIO_MARKER + (texto || SEM_TRANSCRICAO);
}

function cleanTranscript(raw) {
  return String(raw || "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 2000);
}

/* O bucket é criado na primeira mensagem de voz, sem ninguém abrir o painel do
   Supabase. Fica privado: só quem tem a URL assinada de 1h ouve. */
let bucketGarantido = false;
async function ensureBucket() {
  if (bucketGarantido) return;
  if (!supabase) throw new ApiError(503, "Configure o Supabase para guardar os áudios do cliente.");
  const { data: buckets } = await supabase.storage.listBuckets();
  const nome = bucketName();
  const existe = (buckets || []).some(b => b.name === nome);
  if (!existe) {
    const { error } = await supabase.storage.createBucket(nome, { public: false, fileSizeLimit: MAX_AUDIO_BYTES });
    if (error && !/already exists|already exists/i.test(error.message || "")) {
      throw new ApiError(502, `Não foi possível criar o bucket ${nome} no Supabase: ${error.message}`);
    }
    console.log(`[audio] Criei o bucket ${nome} no Supabase (privado) para os áudios do cliente.`);
  }
  bucketGarantido = true;
}

async function uploadAudio({ conversationId, messageId, buffer, mimetype }) {
  await ensureBucket();
  const path = objectPath(conversationId, messageId);
  const { error } = await supabase.storage
    .from(bucketName())
    .upload(path, buffer, { contentType: mimetype || "audio/ogg", upsert: true });
  if (error) throw new ApiError(502, `O Supabase não guardou o áudio do cliente: ${error.message}`);
  return path;
}

/* A Groq aceita ogg/opus direto (mesmo formato que o WhatsApp envia), então não
   passa por FFmpeg. Sem GROQ_API_KEY, a mensagem continua com o áudio e só fica
   sem transcrição. */
async function transcribeAudio(buffer, mimetype) {
  const apiKey = String(process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) return { text: "", reason: "sem chave Groq" };

  const modelos = [whisperModel(), "whisper-large-v3"].filter((m, i, lista) => m && lista.indexOf(m) === i);
  let ultimoErro = "";
  for (const model of modelos) {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimetype || "audio/ogg; codecs=opus" }), "audio.ogg");
    form.append("model", model);
    form.append("language", "pt");
    form.append("response_format", "json");
    form.append("temperature", "0");
    let response;
    try {
      response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      ultimoErro = error?.name === "TimeoutError" ? "a transcrição demorou demais" : "não foi possível falar com a Groq";
      continue;
    }
    if (!response.ok) {
      const texto = await response.text().catch(() => "");
      let detalhe = texto.slice(0, 160);
      try { detalhe = JSON.parse(texto)?.error?.message || detalhe; } catch (_) {}
      ultimoErro = `HTTP ${response.status}: ${detalhe}`;
      /* Cota estourada ou modelo aposentado: tenta o próximo modelo e para. */
      continue;
    }
    const body = await response.json().catch(() => null);
    const text = cleanTranscript(body?.text);
    if (text) return { text, model };
    ultimoErro = "a Groq devolveu transcrição vazia";
  }
  return { text: "", reason: ultimoErro || "falha desconhecida" };
}

/* URL assinada para o navegador tocar direto do Supabase, sem o arquivo passar
   pelo PC do Erick. Cache simples porque a conversa é recarregada a cada
   sincronização e o mesmo áudio apareceria assinado de novo toda vez. */
const urlCache = new Map();
async function signedUrlForObject(path) {
  if (!path || !supabase) return null;
  const ttl = signedUrlTtl();
  const agora = Date.now();
  const cached = urlCache.get(path);
  if (cached && cached.expiraEm > agora + 60_000) return cached.url;
  const { data, error } = await supabase.storage.from(bucketName()).createSignedUrl(path, ttl);
  if (error || !data?.signedUrl) {
    if (cached) urlCache.delete(path);
    return cached?.url || null;
  }
  const url = data.signedUrl;
  urlCache.set(path, { url, expiraEm: agora + ttl * 1000 });
  if (urlCache.size > 300) urlCache.delete(urlCache.keys().next().value);
  return url;
}

/* Conversa excluída no CRM também apaga os áudios dela do Storage: o plano
   gratuito do Supabase tem 1 GB e a conversa sumida não pode deixar voz do
   cliente para trás. */
async function removeAudioFromConversation(conversationId) {
  if (!supabase) return 0;
  const pasta = safeSegment(conversationId);
  const { data: objetos, error } = await supabase.storage.from(bucketName()).list(pasta, { limit: 1000 });
  if (error || !objetos?.length) return 0;
  const caminhos = objetos.map(item => `${pasta}/${item.name}`);
  await supabase.storage.from(bucketName()).remove(caminhos);
  caminhos.forEach(caminho => urlCache.delete(caminho));
  return caminhos.length;
}

module.exports = {
  AUDIO_MARKER,
  SEM_TRANSCRICAO,
  MAX_AUDIO_BYTES,
  bucketName,
  whisperModel,
  objectPath,
  isAudioContent,
  transcriptContent,
  cleanTranscript,
  ensureBucket,
  uploadAudio,
  transcribeAudio,
  signedUrlForObject,
  removeAudioFromConversation,
};
