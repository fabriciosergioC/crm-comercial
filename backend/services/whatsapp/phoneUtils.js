"use strict";

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeWhatsAppPhone(value) {
  const digits = phoneDigits(value);
  const input = String(value || "").trim();
  const explicitlyInternational = input.startsWith("+") || input.startsWith("00");
  const normalizedDigits = input.startsWith("00") ? digits.slice(2) : digits;
  if (!explicitlyInternational && (normalizedDigits.length === 10 || normalizedDigits.length === 11)) return `55${normalizedDigits}`;
  return normalizedDigits.length >= 8 && normalizedDigits.length <= 15 ? normalizedDigits : null;
}

/* Os dois formatos do MESMO celular brasileiro: com e sem o nono dígito.
   O lead é captado com um (Google Places costuma mostrar o número sem o 9) e o
   WhatsApp do cliente é o outro. Devolve o irmão, ou null se o número não for
   um celular brasileiro em que essa troca faça sentido.

   O fixo não entra: no Brasil o assinante do telefone fixo começa com 2, 3 ou 4
   (e o 6/7 é PABX/espacial). Só 8 e 9 foram, de fato, a primeira casa dos
   celulares antes do nono dígito existir. Sem esse corte, um fixo "55 31
   3876-5432" inventaria um celular "55 31 98765-4320" que pode ser de outra
   pessoa, e a conversa de um viraria a do outro. */
function irmaDoNove(value) {
  const digits = phoneDigits(value);
  const comNove = digits.match(/^55(\d{2})9([89]\d{7})$/);
  if (comNove) return `55${comNove[1]}${comNove[2]}`;
  const semNove = digits.match(/^55(\d{2})([89]\d{7})$/);
  if (semNove) return `55${semNove[1]}9${semNove[2]}`;
  return null;
}

/* São o mesmo celular? Vale para número igual e para o par com/sem o nono
   dígito. É o que impede uma resposta do cliente de abrir segunda ficha no menu
   do WhatsApp quando o cadastro tem o número na outra formato. */
function mesmoCelular(a, b) {
  const x = phoneDigits(a);
  const y = phoneDigits(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return irmaDoNove(x) === y || irmaDoNove(y) === x;
}

function messageStatusFromBaileys(status) {
  const statuses = {
    0: "error",
    1: "pending",
    2: "sent",
    3: "delivered",
    4: "read",
    5: "played",
  };
  return statuses[status] || null;
}

function messageStatusAfterSend(status) {
  const normalized = typeof status === "string" ? status : messageStatusFromBaileys(status);
  return normalized && normalized !== "pending" ? normalized : "sent";
}

module.exports = { phoneDigits, normalizeWhatsAppPhone, irmaDoNove, mesmoCelular, messageStatusFromBaileys, messageStatusAfterSend };
