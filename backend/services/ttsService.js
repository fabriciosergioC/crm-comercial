"use strict";

const { spawn } = require("node:child_process");
const { ApiError } = require("../middleware/errorHandler");

const MAX_TEXT_LENGTH = 3000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/* Ajustes de voz vêm do .env para poderem ser mudados sem mexer no código.
   speed da API só é aceito até 1.2 em eleven_turbo_v2_5; acima disso o provedor
   responde 400 invalid_voice_settings, então o excedente sai do TTS_TEMPO (FFmpeg). */
function readNumber(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function defaultModelId() {
  return process.env.TTS_MODEL_ID || process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
}

/* Perfis de voz que aparecem como botão no chat. Cada um escolhe modelo e ajustes;
   o modelo do perfil "natural" pode ser trocado no .env sem mexer no código. */
const VOICE_PROFILES = {
  rapida: {
    label: "Rápida",
    hint: "Modelo turbo: economiza crédito e responde na hora.",
    modelId: () => defaultModelId(),
    moreExpensive: false,
  },
  natural: {
    label: "Natural",
    hint: "Modelo v3: mais humana, com pausas. Gasta mais crédito.",
    modelId: () => process.env.TTS_NATURAL_MODEL_ID || "eleven_v3",
    // O v3 lê estas tags no meio do texto; outras entre colchetes são descartadas.
    allowedTags: () => new Set(
      String(process.env.TTS_V3_TAGS || "pause,excited,curious,calm,whisper")
        .split(",").map(tag => tag.trim().toLowerCase()).filter(Boolean)
    ),
    settings: () => ({
      stability: readNumber("TTS_NATURAL_STABILITY", 0.30, 0, 1),
      similarity_boost: readNumber("TTS_SIMILARITY_BOOST", 0.85, 0, 1),
      style: readNumber("TTS_NATURAL_STYLE", 0.35, 0, 1),
      use_speaker_boost: true,
      speed: readNumber("TTS_NATURAL_SPEED", 1.1, 0.5, 2),
    }),
    moreExpensive: true,
  },
};

function defaultProfileKey() {
  const wanted = String(process.env.TTS_DEFAULT_PROFILE || "").trim();
  return Object.prototype.hasOwnProperty.call(VOICE_PROFILES, wanted) ? wanted : "rapida";
}

function resolveProfile(profileId) {
  const key = String(profileId || "").trim() || defaultProfileKey();
  if (!Object.prototype.hasOwnProperty.call(VOICE_PROFILES, key)) {
    throw new ApiError(400, `Perfil de voz desconhecido: ${key}. Use ${Object.keys(VOICE_PROFILES).join(" ou ")}.`);
  }
  return { key, ...VOICE_PROFILES[key] };
}

function buildVoiceSettings(modelId) {
  const modelo = String(modelId);
  const aceitaSpeed = /turbo|flash|v3/.test(modelo);
  // eleven_v3 aceita speed até 2.0; turbo/flash param em 1.2 (acima disso dá 400).
  const maxSpeed = /v3/.test(modelo) ? 2 : 1.2;
  return {
    stability: readNumber("TTS_STABILITY", 0.45, 0, 1),
    similarity_boost: readNumber("TTS_SIMILARITY_BOOST", 0.75, 0, 1),
    ...(aceitaSpeed ? { style: readNumber("TTS_STYLE", 0.15, 0, 1) } : {}),
    use_speaker_boost: readNumber("TTS_SPEAKER_BOOST", 1, 0, 1) >= 1,
    ...(aceitaSpeed ? { speed: readNumber("TTS_SPEED", 1, 0.5, maxSpeed) } : {}),
  };
}

/* Lugares de preenchimento ([NOME], [EMPRESA]) não podem virar fala.
   Tag válida do modelo permanece; o resto do que está entre colchetes sai do áudio. */
const PLACEHOLDER_PATTERN = /^\s*[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ\s]{1,30}$/;
function prepareSpokenText(text, allowedTags) {
  const leftovers = [];
  const dropped = [];
  const spoken = String(text).replace(/\[([^\]\n]{1,40})\]/g, (whole, inner) => {
    const token = String(inner).trim();
    if (PLACEHOLDER_PATTERN.test(token)) { leftovers.push(token); return ""; }
    if (allowedTags && allowedTags.has(token.toLowerCase())) return `[${token.toLowerCase()}]`;
    dropped.push(token);
    return "";
  }).replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
  if (dropped.length) {
    console.warn(`[tts] Ignorei tags que o modelo não conhece: ${dropped.join(", ")}`);
  }
  if (leftovers.length) {
    throw new ApiError(400, `O texto ainda tem campos para preencher (${leftovers.join(", ")}). Complete a mensagem antes de gerar o áudio.`);
  }
  // Se só sobraram tags e nenhuma palavra, o provedor devolve um erro sem graça.
  if (!spoken.replace(/\[[^\]\n]+\]/g, "").trim()) {
    throw new ApiError(400, "Escreva a mensagem antes de gerar o áudio; sobraram apenas marcações de pausa.");
  }
  return spoken;
}


/* Acelera o áudio sem mudar o tom do timbre (atempo preserva a afinação). */
function applyTempo(input, factor) {
  return new Promise((resolve, reject) => {
    if (!(factor >= 0.5 && factor <= 2.0)) {
      reject(new Error(`TTS_TEMPO fora da faixa que o FFmpeg aceita (0.5 a 2.0): ${factor}`));
      return;
    }
    let ffmpegPath;
    try {
      ffmpegPath = process.env.FFMPEG_BIN || require("ffmpeg-static");
    } catch (_) {
      reject(new Error("FFmpeg indisponível"));
      return;
    }
    if (!ffmpegPath) { reject(new Error("FFmpeg indisponível")); return; }
    let child;
    try {
      child = spawn(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", "pipe:0", "-vn",
        "-filter:a", `atempo=${factor}`,
        "-c:a", "libmp3lame", "-b:a", "128k",
        "-f", "mp3", "pipe:1",
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) { reject(error); return; }
    const out = [];
    let bytes = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("tempo excedeu o limite")); }, 20000);
    child.stdout.on("data", chunk => { bytes += chunk.length; out.push(chunk); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0 || bytes === 0) { reject(new Error(`ffmpeg atempo saiu com código ${code}`)); return; }
      resolve(Buffer.concat(out, bytes));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/* Lê apenas o código/status do erro do provedor, nunca o corpo bruto nem credenciais. */
async function readProviderDetail(response) {
  try {
    const body = await response.json();
    const detail = body?.detail;
    return {
      code: String(detail?.code || "").toLowerCase(),
      status: String(typeof detail === "string" ? detail : detail?.status || "").toLowerCase(),
    };
  } catch (_) {
    return { code: "", status: "" };
  }
}

/* Traduz falhas do provedor em ações concretas para quem configura o .env. */
function providerFailure(httpStatus, detail) {
  const signals = `${detail.code} ${detail.status}`;
  if (signals.includes("api_key_id_used_as_api_key") || signals.includes("invalid_api_key")) {
    return [503, "O ELEVENLABS_API_KEY do backend não é uma chave secreta válida: você colou o ID da chave (64 caracteres hexadecimais). Copie a chave que começa com sk_ em platform.elevenlabs.io (API Keys) e reinicie o backend."];
  }
  if (signals.includes("missing_permissions") || signals.includes("unauthorized_public") || httpStatus === 401 || httpStatus === 403) {
    return [503, "A chave da ElevenLabs está correta, mas sem permissão de gerar áudio. Edite a chave no painel da ElevenLabs e marque a permissão text_to_speech (e voices_read para conferir o Voice ID). Não é preciso trocar o valor no .env."];
  }
  if (httpStatus === 429) {
    return [429, "O limite de geração de áudio foi atingido. Aguarde e tente novamente."];
  }
  if (signals.includes("invalid_voice") || signals.includes("voice_not_found") || signals.includes("wrong_voice_id") || httpStatus === 404) {
    return [503, `O ELEVENLABS_VOICE_ID não existe nesta conta de voz. Abra a lista de vozes do painel, escolha uma e cole o Voice ID dela na linha ELEVENLABS_VOICE_ID do backend\\.env.`];
  }
  if (signals.includes("paid_plan_required") || signals.includes("payment_required") || httpStatus === 402) {
    return [503, "Esta voz é de biblioteca e o plano gratuito da ElevenLabs não permite usá-la pela API. Troque o ELEVENLABS_VOICE_ID por uma voz padrão da conta (categoria premade) ou assine um plano pago."];
  }
  if (signals.includes("wrong_model_id") || signals.includes("model_not_allowed")) {
    return [503, "O ELEVENLABS_MODEL_ID não é permitido para esta voz ou plano. Use eleven_multilingual_v2."];
  }
  if (signals.includes("quota_exceeded") || signals.includes("character_limit")) {
    return [429, "O limite de caracteres do plano da ElevenLabs foi consumido. Aguarde a renovação da cota ou use um texto menor."];
  }
  if (signals.includes("invalid_voice_settings")) {
    return [503, "Um ajuste de voz no backend\\.env está fora do limite que a ElevenLabs aceita. speed vai até 1.2 nos modelos turbo/flash e até 2.0 no eleven_v3; stability, similarity e style vão de 0 a 1."];
  }
  if (httpStatus === 400) {
    return [400, "O serviço de voz recusou o texto ou a combinação de voz e modelo. Reduza o texto e confira o Voice ID e o ELEVENLABS_MODEL_ID."];
  }
  return [502, `O serviço de voz não conseguiu gerar o áudio (o provedor respondeu HTTP ${httpStatus}).`];
}

async function generateSpeech(text, profileId) {
  if (typeof text !== "string" || !text.trim()) {
    throw new ApiError(400, "Digite uma mensagem para gerar o áudio.");
  }
  const profile = resolveProfile(profileId);
  const modelId = profile.modelId();
  const normalizedText = prepareSpokenText(text.trim(), profile.allowedTags && profile.allowedTags());
  if (normalizedText.length > MAX_TEXT_LENGTH) {
    throw new ApiError(400, `O texto não pode ultrapassar ${MAX_TEXT_LENGTH} caracteres para gerar áudio.`);
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    throw new ApiError(503, "Configure ELEVENLABS_API_KEY e ELEVENLABS_VOICE_ID no arquivo .env do backend para ativar a geração de áudio.");
  }

  const voiceSettings = typeof profile.settings === "function" ? profile.settings() : buildVoiceSettings(modelId);
  let response;
  try {
    response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: normalizedText,
          model_id: modelId,
          voice_settings: voiceSettings,
        }),
        signal: AbortSignal.timeout(45000),
      }
    );
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ApiError(504, "A geração do áudio demorou demais. Tente novamente.");
    }
    throw new ApiError(502, "Não foi possível conectar ao serviço de geração de voz.");
  }

  if (!response.ok) {
    throw new ApiError(...providerFailure(response.status, await readProviderDetail(response)));
  }

  const arrayBuffer = await response.arrayBuffer();
  if (!arrayBuffer.byteLength || arrayBuffer.byteLength > MAX_AUDIO_BYTES) {
    throw new ApiError(arrayBuffer.byteLength ? 413 : 502, arrayBuffer.byteLength
      ? "O áudio gerado excede o limite de 8 MB. Reduza o tamanho do texto."
      : "O serviço de voz retornou um áudio vazio.");
  }
  const generated = Buffer.from(arrayBuffer);

  const tempo = readNumber("TTS_TEMPO", 1, 0.8, 1.6);
  if (tempo === 1) return generated;
  try {
    const sped = await applyTempo(generated, tempo);
    if (!sped.length || sped.length > MAX_AUDIO_BYTES) return generated;
    return sped;
  } catch (error) {
    /* Áudio um pouco mais lento é preferível a não gerar áudio nenhum. */
    console.warn("[tts] Não consegui acelerar o áudio, enviando na velocidade do provedor:", error.message);
    return generated;
  }
}

/* O que a interface mostra no seletor de voz (sem expor chave nem Voice ID). */
function listVoiceProfiles() {
  const preferred = defaultProfileKey();
  return Object.keys(VOICE_PROFILES).map(key => {
    const profile = VOICE_PROFILES[key];
    return {
      key,
      label: profile.label,
      hint: profile.hint,
      modelId: profile.modelId(),
      moreExpensive: Boolean(profile.moreExpensive),
      isDefault: key === preferred,
    };
  });
}

module.exports = { generateSpeech, listVoiceProfiles, MAX_TEXT_LENGTH, MAX_AUDIO_BYTES };
