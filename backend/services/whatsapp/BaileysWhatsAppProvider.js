"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const pino = require("pino");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const WhatsAppProvider = require("./WhatsAppProvider");
const { phoneDigits, normalizeWhatsAppPhone, messageStatusFromBaileys } = require("./phoneUtils");
const { supabase, isConfigured: supabaseConfigured } = require("../../config/supabase");
const { ApiError } = require("../../middleware/errorHandler");

const AUTH_DIR = path.resolve(process.env.WHATSAPP_AUTH_DIR || path.join(__dirname, "../../../data/whatsapp-auth"));
const CONNECTION_TIMEOUT_MS = 30000;

function jidToPhone(jid) { return phoneDigits(String(jid || "").split("@")[0]); }
function incomingPhone(key) {
  const jid = key?.remoteJid;
  if (!jid || /@(g\.us|broadcast|newsletter|status)$/i.test(jid)) return null;

  const candidate = /@(lid|hosted\.lid)$/i.test(jid) ? key.remoteJidAlt : jid;
  if (!candidate || !/@(s\.whatsapp\.net|c\.us)$/i.test(candidate)) return null;

  const phone = jidToPhone(candidate);
  return phone.length >= 8 && phone.length <= 15 ? phone : null;
}
function messageText(message) {
  const m = message?.message || {};
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || m.buttonsResponseMessage?.selectedDisplayText || m.listResponseMessage?.title || m.templateButtonReplyMessage?.selectedDisplayText || (m.imageMessage ? "[Imagem]" : m.videoMessage ? "[Vídeo]" : m.audioMessage ? "[Áudio]" : m.documentMessage ? "[Documento]" : "[Mensagem não textual]");
}
function timestampFromMessage(msg) {
  const seconds = Number(msg?.messageTimestamp || 0);
  return seconds ? new Date(seconds * 1000).toISOString() : new Date().toISOString();
}
function assertSupabase() {
  if (!supabaseConfigured || !supabase) throw new ApiError(503, "Configure o Supabase para armazenar as conversas do WhatsApp.");
}

function archiveRejectedAuthState() {
  if (!fs.existsSync(AUTH_DIR)) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = `${AUTH_DIR}.rejected-${timestamp}`;
  fs.renameSync(AUTH_DIR, archiveDir);
}

function databaseError(error, message) {
  if (error?.code === "PGRST205" || error?.code === "42P01") {
    return new ApiError(
      503,
      "As tabelas do WhatsApp não existem no Supabase. Execute backend/database/migrations/005_whatsapp_baileys.sql no SQL Editor."
    );
  }
  return new ApiError(502, message);
}

class BaileysWhatsAppProvider extends WhatsAppProvider {
  constructor() {
    super();
    this.sock = null;
    this.status = "DISCONNECTED";
    this.qrCode = null;
    this.qrImage = null;
    this.pairingCode = null;
    this.phoneNumber = null;
    this.accountName = null;
    this.lastSyncAt = null;
    this.errors = [];
    this.connectPromise = null;
    this.startRequestedPhone = null;
    this.connectionTimeout = null;
    this.connectionStartedAt = null;
    this.stopRequested = false;
    this.recentMessageStatuses = new Map();
  }

  async getStatus() {
    if (
      this.status === "CONNECTING" &&
      this.connectionStartedAt &&
      Date.now() - this.connectionStartedAt >= CONNECTION_TIMEOUT_MS
    ) {
      this.expireConnection(
        this.sock,
        "O WhatsApp não respondeu em 30 segundos. Verifique a conexão com a internet e tente novamente."
      );
    }

    return {
      provider: "baileys",
      mode: "whatsapp-web",
      status: this.status,
      phoneNumber: this.phoneNumber,
      accountName: this.accountName,
      lastSyncAt: this.lastSyncAt,
      pendingMessages: 0,
      errors: this.errors.slice(-5),
      qrImage: this.qrImage,
      qrAvailable: Boolean(this.qrCode),
      pairingCode: this.pairingCode,
      pairingAvailable: Boolean(this.pairingCode),
    };
  }

  async connect(options = {}) {
    if (this.status === "CONNECTED") return this.getStatus();
    if (this.connectPromise) return this.connectPromise;
    this.startRequestedPhone = phoneDigits(options.phoneNumber || process.env.WHATSAPP_PAIRING_PHONE || "");
    this.connectPromise = this._connect().catch(error => {
      if (error instanceof ApiError) throw error;
      this.failConnection(error);
      return this.getStatus();
    }).finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  async _connect() {
    assertSupabase();
    this.stopRequested = false;
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion({ timeout: 8000 });
    this.status = "CONNECTING";
    this.connectionStartedAt = Date.now();
    this.qrCode = null;
    this.qrImage = null;
    this.pairingCode = null;
    this.errors = [];
    const sock = makeWASocket({
      auth: state,
      version,
      browser: Browsers.macOS("Desktop"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: jid => jid?.endsWith("@g.us") || jid?.endsWith("@broadcast") || jid === "status@broadcast",
      logger: pino({ level: "silent" }),
    });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", event => { this.handleIncoming(event).catch(error => this.errors.push(error.message || String(error))); });
    sock.ev.on("messages.update", updates => {
      this.handleMessageUpdates(updates).catch(error => this.errors.push(error.message || String(error)));
    });

    sock.ev.on("connection.update", async update => {
      if (this.sock !== sock || this.stopRequested) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
        this.connectionStartedAt = null;
        this.qrCode = qr;
        this.qrImage = null;
        this.pairingCode = null;
        this.status = "QR_READY";
        try {
          const qrImage = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: "M",
            margin: 2,
            width: 256,
          });
          if (this.sock === sock && this.status === "QR_READY") {
            this.qrImage = qrImage;
          }
        } catch (error) {
          if (this.sock === sock) {
            this.status = "ERROR";
            this.errors.push(`Não foi possível gerar a imagem do QR Code: ${error.message || String(error)}`);
          }
        }
      }
      if (connection === "open") {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
        this.connectionStartedAt = null;
        this.status = "CONNECTED";
        this.qrCode = null;
        this.qrImage = null;
        this.pairingCode = null;
        this.phoneNumber = jidToPhone(sock.user?.id);
        this.accountName = sock.user?.name || null;
        this.lastSyncAt = new Date().toISOString();
      }
      if (connection === "close") {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
        this.connectionStartedAt = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        const disconnectMessage = lastDisconnect?.error?.message || "Conexão encerrada pelo WhatsApp.";
        this.sock = null;
        this.qrCode = null;
        this.qrImage = null;
        this.pairingCode = null;
        this.status = loggedOut ? "DISCONNECTED" : "RECONNECTING";
        if (loggedOut) {
          try {
            archiveRejectedAuthState();
            const rawReason = lastDisconnect?.error?.data?.reason;
            const reason = /^\d{1,4}$/.test(String(rawReason || ""))
              ? `, motivo ${rawReason}`
              : "";
            const message = state.creds.registered
              ? `O WhatsApp rejeitou a sessão vinculada (401${reason}). Ela foi arquivada; tente conectar novamente.`
              : `O WhatsApp recusou o QR antes de concluir o vínculo (401${reason}). A sessão incompleta foi arquivada; tente o código de pareamento pelo número com DDI.`;
            this.errors.push(message);
          } catch (error) {
            this.errors.push(`O WhatsApp rejeitou a sessão (401), mas não foi possível arquivá-la: ${error.message || String(error)}. Remova manualmente os arquivos no diretório configurado por WHATSAPP_AUTH_DIR e tente novamente.`);
          }
        } else if (code === DisconnectReason.restartRequired) {
          this.errors.push("O pareamento foi iniciado; o WhatsApp está reiniciando a conexão para concluir o login.");
        } else if (code === DisconnectReason.timedOut) {
          this.errors.push("O QR Code expirou antes de concluir o pareamento. Escaneie o próximo QR Code assim que aparecer.");
        } else {
          const reason = code ? ` (código ${code})` : "";
          this.errors.push(`${disconnectMessage}${reason}`);
        }
        if (!loggedOut) setTimeout(() => this.connect({ phoneNumber: this.startRequestedPhone }).catch(() => {}), 1500);
      }
    });

    this.connectionTimeout = setTimeout(() => {
      if (this.sock !== sock || this.status !== "CONNECTING") return;
      this.expireConnection(
        sock,
        "O WhatsApp não respondeu em 30 segundos. Verifique a conexão com a internet e tente novamente."
      );
    }, CONNECTION_TIMEOUT_MS);

    if (!state.creds.registered && this.startRequestedPhone) {
      let pairingTimeout;
      try {
        await new Promise(resolve => setTimeout(resolve, 500));
        this.pairingCode = await Promise.race([
          sock.requestPairingCode(this.startRequestedPhone),
          new Promise((_, reject) => {
            pairingTimeout = setTimeout(
              () => reject(new Error("O WhatsApp demorou para gerar o código de pareamento. Tente novamente.")),
              15000
            );
          })
        ]);
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
        this.connectionStartedAt = null;
        this.qrCode = null;
        this.qrImage = null;
        this.status = "PAIRING_READY";
      } catch (error) {
        this.errors.push(error.message || String(error));
        this.status = "ERROR";
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
        this.connectionStartedAt = null;
        this.stopRequested = true;
        this.sock = null;
        sock.end(undefined);
      } finally {
        clearTimeout(pairingTimeout);
      }
    }

    return this.getStatus();
  }

  expireConnection(sock, message) {
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.connectionStartedAt = null;
    this.stopRequested = true;
    this.status = "ERROR";
    this.errors.push(message);
    if (sock && this.sock === sock) {
      this.sock = null;
      sock.end(undefined);
    }
  }

  failConnection(error) {
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.connectionStartedAt = null;
    this.stopRequested = true;
    this.status = "ERROR";
    this.errors.push(`Falha ao iniciar o WhatsApp: ${error.message || String(error)}`);
    const sock = this.sock;
    this.sock = null;
    if (sock) sock.end(undefined);
  }

  async disconnect() {
    this.stopRequested = true;
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.connectionStartedAt = null;
    if (this.sock) {
      try { await this.sock.logout(); } catch (_) { try { this.sock.end(undefined); } catch (_) {} }
    }
    this.sock = null;
    this.status = "DISCONNECTED";
    this.qrCode = null;
    this.qrImage = null;
    this.pairingCode = null;
    this.phoneNumber = null;
    this.accountName = null;
    return this.getStatus();
  }

  async listConversations() {
    assertSupabase();
    const { data, error } = await supabase.from("whatsapp_conversations").select("*").order("updated_at", { ascending: false });
    if (error) throw databaseError(error, "Falha ao consultar conversas do WhatsApp.");
    const ids = (data || []).map(r => r.id);
    let last = [];
    if (ids.length) {
      const result = await supabase.from("whatsapp_messages").select("*").in("conversation_id", ids).order("timestamp", { ascending: false });
      if (result.error) throw databaseError(result.error, "Falha ao consultar mensagens do WhatsApp.");
      last = result.data || [];
    }
    const latest = new Map();
    for (const m of last) if (!latest.has(m.conversation_id)) latest.set(m.conversation_id, m);
    return (data || []).map(row => this.mapConversation(row, latest.get(row.id)));
  }

  async openLeadConversation(lead) {
    assertSupabase();
    const row = await this.ensureConversation(lead.phone, lead.contactName, lead.company);
    return this.getConversation(row.id);
  }

  mapConversation(row, lastMessage = null) {
    return {
      id: row.id,
      contact: { name: row.contact_name || row.phone, phone: row.phone, company: row.company || "" },
      status: row.status || "Em atendimento",
      unreadCount: row.unread_count || 0,
      lastMessage: lastMessage ? { id: lastMessage.id, direction: lastMessage.direction, content: lastMessage.content, timestamp: lastMessage.timestamp, status: lastMessage.status } : null,
    };
  }

  async getConversation(id) {
    assertSupabase();
    const { data: row, error } = await supabase.from("whatsapp_conversations").select("*").eq("id", id).maybeSingle();
    if (error) throw databaseError(error, "Falha ao consultar a conversa do WhatsApp.");
    if (!row) return null;
    const { data: messages, error: msgError } = await supabase.from("whatsapp_messages").select("*").eq("conversation_id", id).order("timestamp", { ascending: true });
    if (msgError) throw databaseError(msgError, "Falha ao consultar mensagens do WhatsApp.");
    const { error: updateError } = await supabase.from("whatsapp_conversations").update({ unread_count: 0 }).eq("id", id);
    if (updateError) throw databaseError(updateError, "Falha ao atualizar a conversa do WhatsApp.");
    return { ...this.mapConversation(row), messages: (messages || []).map(m => ({ id: m.id, direction: m.direction, content: m.content, timestamp: m.timestamp, status: m.status, sentBy: m.sent_by || null })) };
  }

  async deleteConversation(id) {
    assertSupabase();
    const { data: row, error: findError } = await supabase.from("whatsapp_conversations").select("id").eq("id", id).maybeSingle();
    if (findError) throw databaseError(findError, "Falha ao consultar a conversa do WhatsApp.");
    if (!row) return false;
    const { error } = await supabase.from("whatsapp_conversations").delete().eq("id", id);
    if (error) throw databaseError(error, "Não foi possível excluir a conversa do WhatsApp.");
    this.lastSyncAt = new Date().toISOString();
    return true;
  }

  async ensureConversation(phone, contactName = null, company = "") {
    const clean = normalizeWhatsAppPhone(phone);
    if (!clean) throw new ApiError(400, "O contato não tem um número de telefone válido para o WhatsApp.");
    const existing = await supabase.from("whatsapp_conversations").select("*").eq("phone", clean).maybeSingle();
    if (existing.error) throw databaseError(existing.error, "Falha ao consultar a conversa recebida.");
    let data = existing.data;
    if (!data) {
      const created = await supabase.from("whatsapp_conversations").insert({ phone: clean, contact_name: contactName || clean, company, status: "Em atendimento", unread_count: 0, updated_at: new Date().toISOString() }).select().single();
      if (created.error) throw databaseError(created.error, "Não foi possível criar a conversa no CRM.");
      data = created.data;
    } else if ((contactName && contactName !== data.contact_name) || (company && company !== data.company)) {
      const patch = {};
      if (contactName && contactName !== data.contact_name) patch.contact_name = contactName;
      if (company && company !== data.company) patch.company = company;
      const updated = await supabase.from("whatsapp_conversations").update(patch).eq("id", data.id);
      if (updated.error) throw databaseError(updated.error, "Não foi possível atualizar o contato da conversa.");
      Object.assign(data, patch);
    }
    return data;
  }

  async sendText(id, content, sentBy) {
    assertSupabase();
    if (!this.sock || this.status !== "CONNECTED") throw new ApiError(409, "Conecte o WhatsApp via Baileys antes de enviar mensagens.");
    const { data: conversation, error: conversationError } = await supabase.from("whatsapp_conversations").select("*").eq("id", id).maybeSingle();
    if (conversationError) throw databaseError(conversationError, "Falha ao consultar o contato antes do envio.");
    if (!conversation) return null;
    const phone = normalizeWhatsAppPhone(conversation.phone);
    if (!phone) throw new ApiError(400, "O contato não tem um número de telefone válido para o WhatsApp.");
    const phoneJid = jidNormalizedUser(`${phone}@s.whatsapp.net`);
    let recipient;
    try {
      const matches = await this.sock.onWhatsApp(phoneJid);
      recipient = matches?.find(match => match.exists && match.jid);
    } catch (error) {
      throw new ApiError(502, `Não foi possível validar o número no WhatsApp. Tente novamente.${error?.message ? ` (${error.message})` : ""}`);
    }
    if (!recipient) {
      throw new ApiError(400, "Este número não foi encontrado no WhatsApp. Confira o DDI, DDD e número cadastrado no lead.");
    }
    let sent;
    try {
      sent = await this.sock.sendMessage(jidNormalizedUser(recipient.jid), { text: content });
    } catch (error) {
      const reason = error?.message ? ` (${error.message})` : "";
      throw new ApiError(502, `O WhatsApp não aceitou o envio da mensagem${reason}.`);
    }
    const messageId = sent?.key?.id || randomUUID();
    const timestamp = new Date().toISOString();
    const initialStatus = this.recentMessageStatuses.get(messageId) || messageStatusFromBaileys(sent?.status) || "pending";
    const { data: saved, error } = await supabase.from("whatsapp_messages").insert({ id: messageId, conversation_id: id, direction: "outgoing", content, timestamp, status: initialStatus, sent_by: sentBy || null, provider_message_id: messageId }).select().single();
    if (error) throw databaseError(error, "A mensagem foi enviada ao WhatsApp, mas não foi possível salvar o histórico.");
    const receiptStatus = this.recentMessageStatuses.get(messageId);
    this.recentMessageStatuses.delete(messageId);
    if (receiptStatus && receiptStatus !== initialStatus) {
      const receiptUpdate = await supabase.from("whatsapp_messages").update({ status: receiptStatus }).eq("provider_message_id", messageId);
      if (receiptUpdate.error) throw databaseError(receiptUpdate.error, "Não foi possível salvar a confirmação de entrega da mensagem.");
    }
    const updated = await supabase.from("whatsapp_conversations").update({ status: "Aguardando resposta", updated_at: timestamp }).eq("id", id);
    if (updated.error) throw databaseError(updated.error, "A mensagem foi enviada, mas não foi possível atualizar a conversa.");
    this.lastSyncAt = timestamp;
    return { id: saved.id, direction: saved.direction, content: saved.content, timestamp: saved.timestamp, status: saved.status, sentBy: saved.sent_by };
  }

  /* Envia um aviso direto para um número (ex.: lembrete de follow-up para o
     próprio dono), SEM criar conversa no CRM — não é um lead. */
  async sendNotification(phone, text) {
    if (!this.sock || this.status !== "CONNECTED") throw new ApiError(409, "Conecte o WhatsApp via Baileys antes de enviar avisos.");
    const clean = normalizeWhatsAppPhone(phone);
    if (!clean) throw new ApiError(400, "Número de aviso inválido. Configure FOLLOWUP_NOTIFY_PHONE com DDI.");
    const phoneJid = jidNormalizedUser(`${clean}@s.whatsapp.net`);
    let recipient;
    try {
      const matches = await this.sock.onWhatsApp(phoneJid);
      recipient = matches?.find(match => match.exists && match.jid);
    } catch (error) {
      throw new ApiError(502, `Não foi possível validar o número de aviso no WhatsApp.${error?.message ? ` (${error.message})` : ""}`);
    }
    if (!recipient) throw new ApiError(400, "O número de aviso (FOLLOWUP_NOTIFY_PHONE) não foi encontrado no WhatsApp.");
    try {
      await this.sock.sendMessage(jidNormalizedUser(recipient.jid), { text });
    } catch (error) {
      throw new ApiError(502, `O WhatsApp não aceitou o envio do aviso${error?.message ? ` (${error.message})` : ""}.`);
    }
    this.lastSyncAt = new Date().toISOString();
    return { phone: clean, status: "sent" };
  }

  async handleMessageUpdates(updates) {
    for (const item of updates || []) {
      const messageId = item?.key?.id;
      const status = messageStatusFromBaileys(item?.update?.status);
      if (!messageId || !status || !item.key.fromMe) continue;
      this.recentMessageStatuses.set(messageId, status);
      if (this.recentMessageStatuses.size > 200) {
        this.recentMessageStatuses.delete(this.recentMessageStatuses.keys().next().value);
      }
      const { error } = await supabase
        .from("whatsapp_messages")
        .update({ status })
        .eq("provider_message_id", messageId)
        .eq("direction", "outgoing");
      if (error) throw databaseError(error, "Não foi possível atualizar a confirmação de entrega da mensagem.");
    }
  }

  async handleIncoming(upsert) {
    if (upsert?.type && !["notify", "append"].includes(upsert.type)) return;
    for (const msg of upsert?.messages || []) {
      if (!msg?.message || msg.key?.fromMe) continue;
      const phone = incomingPhone(msg.key);
      if (!phone) continue;
      const content = messageText(msg);
      const contactName = msg.pushName || phone;
      const timestamp = timestampFromMessage(msg);
      const conversation = await this.ensureConversation(phone, contactName);
      const messageId = msg.key?.id || randomUUID();
      const inserted = await supabase.from("whatsapp_messages").upsert({ id: messageId, conversation_id: conversation.id, direction: "incoming", content, timestamp, status: "delivered", provider_message_id: messageId }, { onConflict: "id" });
      if (inserted.error) throw databaseError(inserted.error, "Não foi possível salvar a mensagem recebida.");
      const updated = await supabase.from("whatsapp_conversations").update({ status: "Em atendimento", unread_count: (conversation.unread_count || 0) + 1, updated_at: timestamp, contact_name: contactName || conversation.contact_name }).eq("id", conversation.id);
      if (updated.error) throw databaseError(updated.error, "Não foi possível atualizar a conversa recebida.");
      this.lastSyncAt = timestamp;
    }
  }

  async simulateIncomingMessage() { throw new ApiError(404, "A simulação foi removida. As mensagens reais entram pelo WhatsApp conectado via Baileys."); }
}

module.exports = BaileysWhatsAppProvider;
module.exports.incomingPhone = incomingPhone;
module.exports.messageStatusFromBaileys = messageStatusFromBaileys;
