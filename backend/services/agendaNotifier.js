"use strict";

/* Agendador de lembretes da AGENDA no Windows.

   Roda só no backend Node persistente (nunca na Vercel serverless), igual ao
   agendador de follow-up por WhatsApp. A cada AGENDA_NOTIFY_INTERVAL_MIN
   minutos (padrão 5) lê direto do Supabase os dois conjuntos que o menu Agenda
   mostra:

     - agenda_events  com status 'agendado'  (reunião, demonstração, tarefa,
       compromisso)
     - lead_followups com status 'pendente'  (os "retornos")

   e dispara notificação nativa do Windows (windowsToast.js) para cada item:

     1. resumo do dia  — 1x por dia, no primeiro tick, listando os itens de hoje;
     2. antecedência   — AGENDA_NOTIFY_LEAD_MIN antes do horário (padrão 15);
     3. no horário     — na hora marcada (janela até AGENDA_NOTIFY_LATE_MIN);
     4. atrasado       — depois de AGENDA_NOTIFY_LATE_MIN sem concluir.

   Cada aviso sai UMA única vez por item/fase: o estado fica em
   data/agenda-notifier-state.json (chave origem:id:fase), então reiniciar o
   run-crm.bat não repete lembrete já dado. Concluir ou cancelar no menu Agenda
   tira o item da varredura e interrompe os avisos. */

const fs = require("fs");
const path = require("path");

const { supabase, isConfigured } = require("../config/supabase");
const leadsService = require("./leadsService");
const windowsToast = require("./windowsToast");

const MAX_PER_TICK = 50;
const MAX_ATTEMPTS = 6;
const STATE_PATH = path.resolve(__dirname, "../../data/agenda-notifier-state.json");

const TYPE_LABEL = {
  reuniao: "Reunião",
  demonstracao: "Demonstração",
  tarefa: "Tarefa",
  compromisso: "Compromisso",
  retorno: "Retorno",
};

const PHASE_LABEL = {
  summary: "Agenda do dia",
  lead: "Lembrete",
  ontime: "Começa agora",
  late: "Atrasado",
};

/* ------------------------------ configuração ----------------------------- */

function isEnabled() {
  return String(process.env.AGENDA_NOTIFY_ENABLED || "true").toLowerCase() !== "false";
}

function minutesOf(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const config = {
  intervalMs: () => Math.max(1, minutesOf("AGENDA_NOTIFY_INTERVAL_MIN", 5)) * 60000,
  leadMs: () => Math.max(0, minutesOf("AGENDA_NOTIFY_LEAD_MIN", 15)) * 60000,
  lateMs: () => Math.max(1, minutesOf("AGENDA_NOTIFY_LATE_MIN", 30)) * 60000,
  lookbackMs: () => Math.max(60, minutesOf("AGENDA_NOTIFY_LOOKBACK_MIN", 720)) * 60000,
  summaryEnabled: () => String(process.env.AGENDA_NOTIFY_SUMMARY || "true").toLowerCase() !== "false",
};

function tz() {
  return process.env.TZ || "America/Sao_Paulo";
}

function dayKey(date, timeZone = tz()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date); // YYYY-MM-DD
}

function formatHour(iso, timeZone = tz()) {
  try {
    return new Date(iso).toLocaleTimeString("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" });
  } catch (_) {
    return String(iso).slice(11, 16);
  }
}

function minutesLabel(ms) {
  const total = Math.max(0, Math.round(Math.abs(ms) / 60000));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/* -------------------------------- estado --------------------------------- */

function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      summaryDays: parsed && typeof parsed.summaryDays === "object" ? parsed.summaryDays : {},
      sent: parsed && typeof parsed.sent === "object" ? parsed.sent : {},
      attempts: parsed && typeof parsed.attempts === "object" ? parsed.attempts : {},
    };
  } catch (_) {
    return { summaryDays: {}, sent: {}, attempts: {} };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
    return true;
  } catch (error) {
    console.warn(`[agenda-notifier] Não consegui gravar o estado em ${STATE_PATH}: ${error.message}`);
    return false;
  }
}

/* Descarta marcas de itens antigos para o arquivo não crescer sem limite. */
function prune(state, now) {
  const horizon = now - 7 * 24 * 60 * 60000;
  for (const [key, value] of Object.entries(state.sent)) {
    if (new Date(value).getTime() < horizon) delete state.sent[key];
  }
  for (const [key, value] of Object.entries(state.attempts)) {
    if (new Date(value.at).getTime() < horizon) delete state.attempts[key];
  }
  for (const [day, value] of Object.entries(state.summaryDays)) {
    if (new Date(value).getTime() < horizon) delete state.summaryDays[day];
  }
  return state;
}

/* ------------------------------- itens ---------------------------------- */

async function collectItems(floorIso, ceilingIso) {
  const items = [];

  const { data: events, error: eventsError } = await supabase
    .from("agenda_events")
    .select("*")
    .eq("status", "agendado")
    .gte("event_at", floorIso)
    .lte("event_at", ceilingIso)
    .order("event_at", { ascending: true })
    .limit(MAX_PER_TICK);
  if (eventsError) throw new Error(`Falha ao consultar a agenda: ${eventsError.message || eventsError}`);

  const { data: followups, error: followupsError } = await supabase
    .from("lead_followups")
    .select("*")
    .eq("status", "pendente")
    .not("due_date", "is", null)
    .gte("due_date", floorIso)
    .lte("due_date", ceilingIso)
    .order("due_date", { ascending: true })
    .limit(MAX_PER_TICK);
  if (followupsError) throw new Error(`Falha ao consultar os retornos: ${followupsError.message || followupsError}`);

  for (const row of events || []) {
    items.push({
      source: "agenda",
      id: row.id,
      type: TYPE_LABEL[row.type] ? row.type : "tarefa",
      title: row.title || "Evento",
      notes: row.notes || "",
      leadId: row.lead_id || null,
      when: row.event_at,
    });
  }
  for (const row of followups || []) {
    items.push({
      source: "followup",
      id: row.id,
      type: "retorno",
      title: row.note || "Retorno",
      notes: "",
      leadId: row.lead_id || null,
      when: row.due_date,
    });
  }
  return items.sort((a, b) => new Date(a.when) - new Date(b.when));
}

/* Nome da empresa do lead, quando houver. Cache por varredura. */
function leadNameFetcher() {
  const cache = new Map();
  return async function leadName(leadId) {
    if (!leadId) return "";
    if (cache.has(leadId)) return cache.get(leadId);
    let name = "";
    try {
      const lead = await leadsService.getById(leadId);
      name = [lead.company, lead.contactName].filter(Boolean).join(" · ");
    } catch (_) {
      name = ""; /* lead removido ou 404: o aviso sai sem o nome */
    }
    cache.set(leadId, name);
    return name;
  };
}

function buildToast(item, phase, now, leadName) {
  const hour = formatHour(item.when);
  const typeLabel = TYPE_LABEL[item.type] || "Evento";
  const when = phase === "lead"
    ? `em ${minutesLabel(new Date(item.when).getTime() - now.getTime())}`
    : phase === "late"
      ? `atrasado ${minutesLabel(now.getTime() - new Date(item.when).getTime())}`
      : "agora";
  const head = `${PHASE_LABEL[phase]} · ${typeLabel}${leadName ? ` · ${leadName}` : ""}`;
  const tail = [`${hour} — ${item.title}`, when];
  if (item.notes) tail.push(item.notes.replace(/\s+/g, " ").slice(0, 120));
  return { title: head.slice(0, 120), body: tail.filter(Boolean).join(" · ") };
}

function phasesFor(item, now) {
  const dueAt = new Date(item.when).getTime();
  const delta = now.getTime() - dueAt;
  if (delta < 0) {
    return -delta <= config.leadMs() && config.leadMs() > 0 ? ["lead"] : [];
  }
  if (delta < config.lateMs()) return ["ontime"];
  return ["late"];
}

/* ---------------------------- varredura manual ---------------------------- */

/* Executa uma varredura. `now` é injetável para teste.
   Retorna { skipped } | { notified: [...], items, failures, summarySent }. */
async function runOnce({ now = new Date(), force = false } = {}) {
  if (!isConfigured || !supabase) return { skipped: "supabase" };
  if (!isEnabled()) return { skipped: "disabled" };
  if (!windowsToast.isSupported()) return { skipped: "not-windows" };

  const state = prune(readState(), now.getTime());
  const results = [];
  let failures = 0;
  let summarySent = null;

  const todayKey = dayKey(now);
  const floor = new Date(now.getTime() - config.lookbackMs()).toISOString();
  const ceiling = new Date(now.getTime() + Math.max(config.leadMs(), 60000)).toISOString();
  const items = await collectItems(floor, ceiling);
  const getLeadName = leadNameFetcher();

  /* 1) Resumo do dia — uma vez por dia (ou quando force). Pega tudo que ainda
        está pendente e vence hoje, mesmo o que já passou da hora. */
  if (config.summaryEnabled() && (force || !state.summaryDays[todayKey])) {
    const horizon = new Date(now.getTime() + 36 * 60 * 60000).toISOString();
    const window = await collectItems(floor, horizon);
    const todaysItems = window.filter(item => dayKey(new Date(item.when)) === todayKey);
    const lines = todaysItems.slice(0, 4).map(item =>
      `${formatHour(item.when)} ${(TYPE_LABEL[item.type] || "Evento")}: ${item.title}`);
    if (todaysItems.length > 4) lines.push(`+${todaysItems.length - 4} outro(s) na agenda`);
    const body = todaysItems.length
      ? lines.join(" · ")
      : "Nenhum compromisso pendente hoje. Bom dia pra prospectar.";
    const toast = await windowsToast.show({
      title: `Agenda de hoje · ${todaysItems.length} item(ns)`,
      body,
      tag: `crm-agenda-summary-${todayKey}`,
    });
    if (toast.ok) {
      state.summaryDays[todayKey] = now.toISOString();
      summarySent = { ok: true, items: todaysItems.length };
    } else {
      summarySent = { ok: false, reason: toast.reason };
    }
  }

  /* 2) Lembrete / no horário / atrasado. */
  for (const item of items) {
    for (const phase of phasesFor(item, now)) {
      const key = `${item.source}:${item.id}:${phase}`;
      if (!force && state.sent[key]) continue;
      const attempts = state.attempts[key] || { count: 0, at: now.toISOString() };
      if (!force && attempts.count >= MAX_ATTEMPTS) continue;

      const leadName = await getLeadName(item.leadId);
      const { title, body } = buildToast(item, phase, now, leadName);
      const toast = await windowsToast.show({ title, body, tag: `crm-agenda-${key}` });
      if (toast.ok) {
        state.sent[key] = now.toISOString();
        delete state.attempts[key];
        results.push({ key, title, ok: true });
      } else {
        state.attempts[key] = { count: attempts.count + 1, at: now.toISOString(), reason: toast.reason };
        failures += 1;
        console.warn(`[agenda-notifier] Toast falhou para ${key}: ${toast.reason}${toast.stderr ? ` (${String(toast.stderr).slice(0, 120)})` : ""}`);
      }
    }
  }

  writeState(state);
  return { notified: results, items: items.length, failures, summarySent };
}

/* Um toast de exemplo, sem depender de ter item na janela. */
async function sendTestToast() {
  if (!windowsToast.isSupported()) return { skipped: "not-windows" };
  const now = new Date();
  return windowsToast.show({
    title: "Lembrete do CRM · Demonstração",
    body: `${formatHour(now.toISOString())} — teste de notificação da agenda (agora)`,
    tag: `crm-agenda-test-${now.getTime()}`,
  });
}

/* ------------------------------- scheduler -------------------------------- */

let timer = null;

function logResult(result) {
  if (!result) return;
  if (result.skipped) {
    const reasons = {
      supabase: "Supabase não configurado — nada a notificar.",
      disabled: "AGENDA_NOTIFY_ENABLED=false — lembretes da agenda desativados.",
      "not-windows": "Este sistema não é Windows — notificações nativas não se aplicam.",
    };
    console.warn(`[agenda-notifier] Pulou: ${reasons[result.skipped] || result.skipped}`);
    return;
  }
  const sent = (result.notified || []).length;
  const summary = result.summarySent ? ", resumo do dia enviado" : "";
  console.log(`[agenda-notifier] ${sent} aviso(s) no Windows${summary} (de ${result.items} item(ns) na janela${result.failures ? `, ${result.failures} falha(s)` : ""}).`);
}

function start() {
  if (timer) return timer;
  if (!isEnabled()) {
    console.log("[agenda-notifier] Desativado (AGENDA_NOTIFY_ENABLED=false).");
    return null;
  }
  if (!windowsToast.isSupported()) {
    console.log("[agenda-notifier] Notificações do Windows só funcionam neste sistema operacional — agendador não iniciado.");
    return null;
  }
  const ms = config.intervalMs();
  console.log(`[agenda-notifier] Agendador ativo: a cada ${Math.round(ms / 60000)} min avisa no Windows os itens da agenda ${config.leadMs()} min antes, na hora e ${config.lateMs()} min depois de atrasar.`);
  const tick = () => {
    runOnce()
      .then(logResult)
      .catch((error) => console.error(`[agenda-notifier] tick falhou: ${error.message || error}`));
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

module.exports = {
  start,
  stop,
  runOnce,
  sendTestToast,
  buildToast,
  phasesFor,
  collectItems,
  dayKey,
  STATE_PATH,
  TYPE_LABEL,
  config,
};
