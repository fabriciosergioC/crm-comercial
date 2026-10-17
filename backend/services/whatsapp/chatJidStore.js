"use strict";

/* O WhatsApp moderno às vezes identifica a conversa por um "LID"
   (ex.: 12345678901234@lid) em vez do número. O CRM grava o número em
   whatsapp_conversations.phone, mas o pedido de mensagens antigas ao celular
   (fetchMessageHistory) precisa do JID REAL do chat — com o número sozinho ele
   erraria a conversa e o celular não mandaria nada.

   Isto guarda o JID visto em cada mensagem, num arquivo JSON ao lado dos outros
   estados em data/. Sem coluna nova no banco e sem migração. */

const fs = require("node:fs");
const path = require("node:path");

const ARQUIVO = path.resolve(
  process.env.WHATSAPP_JID_STORE || path.join(__dirname, "../../../data/whatsapp-jids.json")
);

let mapa = null;
let gravarAgendado = null;

function carregar() {
  if (mapa) return mapa;
  try {
    const bruto = JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
    mapa = new Map(Object.entries(bruto && typeof bruto === "object" ? bruto : {}));
  } catch (_) {
    mapa = new Map();
  }
  return mapa;
}

/* Escrita agrupada: o celular manda lotes de centenas de mensagens e cada uma
   delas conhece o próprio JID — gravar o arquivo a cada mensagem travaria o
   atendimento. */
function agendarGravacao() {
  if (gravarAgendado) return;
  gravarAgendado = setTimeout(() => {
    gravarAgendado = null;
    try {
      fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
      fs.writeFileSync(ARQUIVO, JSON.stringify(Object.fromEntries(carregar()), null, 0));
    } catch (error) {
      console.warn("[jid] Não consegui salvar os JIDs dos chats:", error?.message || error);
    }
  }, 2000);
  gravarAgendado.unref?.();
}

function registrarJid(phone, jid) {
  if (!phone || typeof jid !== "string" || !jid) return;
  const atual = carregar();
  if (atual.get(phone) === jid) return;
  atual.set(phone, jid);
  agendarGravacao();
}

function jidDe(phone) {
  return phone ? carregar().get(String(phone)) || null : null;
}

/* A conversa foi excluída do CRM: o JID dela não serve para mais nada. */
function esquecerJid(phone) {
  if (!phone || !mapa || !mapa.has(String(phone))) return;
  mapa.delete(String(phone));
  agendarGravacao();
}

module.exports = { registrarJid, jidDe, esquecerJid, arquivo: () => ARQUIVO };
