"use strict";

/* Agendador de lembretes de follow-up.

   Roda apenas no backend Node.js persistente (não na Vercel serverless). A cada
   FOLLOWUP_SCHEDULER_INTERVAL_MIN minutos (padrão 15) procura follow-ups
   "pendente" VENCIDOS ou QUE VENCEM HOJE (due_date <= fim do dia de hoje, no
   fuso TZ/America/Sao_Paulo) e envia um WhatsApp para FOLLOWUP_NOTIFY_PHONE.

   Modelo: REPETE a cada varredura enquanto o follow-up continuar "pendente".
   Só para quando é confirmado/concluído (status "concluido") ou cancelado no
   menu de follow-ups — ou seja, quando sai de "pendente". notified_at guarda
   apenas o horário do ÚLTIMO aviso (informativo), não bloqueia reenvio. */

const { supabase, isConfigured } = require("../config/supabase");
const whatsappService = require("./whatsapp/WhatsAppService");
const leadsService = require("./leadsService");

const MAX_PER_TICK = 50;

function isEnabled() {
  return String(process.env.FOLLOWUP_NOTIFY_ENABLED || "true").toLowerCase() !== "false";
}

function notifyPhone() {
  return String(process.env.FOLLOWUP_NOTIFY_PHONE || "").replace(/\D/g, "");
}

function intervalMs() {
  const min = Number(process.env.FOLLOWUP_SCHEDULER_INTERVAL_MIN || 15);
  const safe = Number.isFinite(min) && min >= 1 ? min : 15;
  return safe * 60 * 1000;
}

function tz() {
  return process.env.TZ || "America/Sao_Paulo";
}

/* Deslocamento (ms) do fuso em relação ao UTC para um instante. */
function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/* Fim do dia de HOJE no fuso configurado, como instante ISO/UTC. A janela de
   aviso é: follow-ups vencidos OU que vencem hoje (due_date <= fim de hoje). */
function endOfTodayIso(now = new Date()) {
  const timeZone = tz();
  const dateStr = new Intl.DateTimeFormat("en-CA", { timeZone }).format(now); // YYYY-MM-DD no fuso
  const [y, m, d] = dateStr.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  return new Date(wall - tzOffsetMs(now, timeZone)).toISOString();
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: tz(),
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch (_) {
    return String(iso);
  }
}

function buildMessage(followup, lead) {
  const name = lead ? [lead.contactName, lead.company].filter(Boolean).join(" — ") : "";
  const overdue = followup.due_date && new Date(followup.due_date).getTime() <= Date.now();
  const lines = [
    overdue ? "FOLLOW-UP VENCIDO" : "FOLLOW-UP VENCE HOJE",
    `Lead: ${name || followup.lead_id}`,
    `Vencimento: ${formatDate(followup.due_date)}`,
  ];
  if (followup.note) lines.push(`Nota: ${followup.note}`);
  lines.push("Confirme (conclua) no menu de follow-ups para parar estes avisos.");
  return lines.join("\n");
}

async function dueFollowups() {
  const horizon = endOfTodayIso();
  const { data, error } = await supabase
    .from("lead_followups")
    .select("*")
    .eq("status", "pendente")
    .not("due_date", "is", null)
    .lte("due_date", horizon)
    .order("due_date", { ascending: true })
    .limit(MAX_PER_TICK);
  if (error) throw new Error(`Falha ao consultar follow-ups: ${error.message || error}`);
  return data || [];
}

/* Executa uma varredura. Retorna um resumo ({ sent, failed, total } ou { skipped }). */
async function runOnce() {
  if (!isConfigured || !supabase) return { skipped: "supabase" };
  const phone = notifyPhone();
  if (!isEnabled() || !phone) return { skipped: "disabled" };

  const status = await whatsappService.getStatus().catch(() => ({ status: "ERROR" }));
  if (status.status !== "CONNECTED") return { skipped: "whatsapp-not-connected", whatsappStatus: status.status };

  const due = await dueFollowups();
  let sent = 0;
  let failed = 0;
  for (const followup of due) {
    try {
      let lead = null;
      try { lead = await leadsService.getById(followup.lead_id); } catch (_) { /* lead opcional na mensagem */ }
      await whatsappService.sendNotification(phone, buildMessage(followup, lead));
      /* notified_at = horário do último aviso (informativo). Falha aqui não
         invalida o envio, então é melhor esforço. */
      await supabase
        .from("lead_followups")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", followup.id);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(`[followup-notifier] Falha no follow-up ${followup.id}: ${error.message || error}`);
    }
  }
  return { sent, failed, total: due.length };
}

const SKIP_REASONS = {
  supabase: "Supabase não configurado (defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY).",
  disabled: "Desativado ou FOLLOWUP_NOTIFY_PHONE vazio.",
  "whatsapp-not-connected": "WhatsApp não está CONNECTED — conecte o Baileys pela tela de conexão.",
};

function logResult(result) {
  if (!result) return;
  if (result.skipped) {
    const extra = result.whatsappStatus ? ` (status: ${result.whatsappStatus})` : "";
    console.warn(`[followup-notifier] Pulou: ${SKIP_REASONS[result.skipped] || result.skipped}${extra}`);
    return;
  }
  if (result.total === 0) {
    console.log("[followup-notifier] Verificou: nenhum follow-up pendente vencido ou vencendo hoje.");
    return;
  }
  console.log(`[followup-notifier] ${result.sent} lembrete(s) enviados, ${result.failed} falha(s), de ${result.total} pendente(s) vencido(s)/de hoje.`);
}

let timer = null;

function start() {
  if (timer) return timer;
  if (!isEnabled()) return null;
  if (!notifyPhone()) {
    console.warn("[followup-notifier] FOLLOWUP_NOTIFY_PHONE vazio — lembretes no celular desativados.");
    return null;
  }
  const ms = intervalMs();
  console.log(`[followup-notifier] Agendador ativo: a cada ${Math.round(ms / 60000)} min reavisa ${notifyPhone()} dos follow-ups pendentes vencidos ou que vencem hoje, até serem confirmados.`);
  const tick = () => {
    runOnce()
      .then(logResult)
      .catch((error) => console.error(`[followup-notifier] tick falhou: ${error.message || error}`));
  };
  tick();
  timer = setInterval(tick, ms);
  if (timer.unref) timer.unref();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, runOnce, buildMessage };
