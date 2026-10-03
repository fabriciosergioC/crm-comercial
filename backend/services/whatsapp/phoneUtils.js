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

module.exports = { phoneDigits, normalizeWhatsAppPhone, messageStatusFromBaileys };
