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
  generateMessageID,
} = require("@whiskeysockets/baileys");
const WhatsAppProvider = require("./WhatsAppProvider");
const { phoneDigits, normalizeWhatsAppPhone, irmaDoNove, messageStatusFromBaileys, messageStatusAfterSend } = require("./phoneUtils");
const conversationStatus = require("./conversationStatus");
const chatJidStore = require("./chatJidStore");
const { convertToOggOpus } = require("./audioConverter");
const incomingAudio = require("./incomingAudioService");
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
/* Rótulo de quem mandou quando a mensagem saiu do APP do WhatsApp, e não do CRM.
   O front usa essa string exata para escrever "pelo celular" na bolha. */
const ENVIADA_PELO_CELULAR = "WhatsApp do celular";
/* Uma mensagem chega viva (notificação de agora), atrasada (o celular entregando
   o que estava offline) ou dentro de um lote de histórico. Só a viva pode mexer
   no status do atendimento e contar como não lida: senão seis meses de papo
   antigo viram "🟠 Respondido" na tela do Erick. */
const MENSAGEM_VIVA_MS = 5 * 60 * 1000;
function mensagemViva(timestamp) {
  const quando = Date.parse(timestamp);
  return Number.isFinite(quando) && Date.now() - quando <= MENSAGEM_VIVA_MS;
}
/* Um await que não pode travar o resto do atendimento: o servidor do WhatsApp
   some com mídia antiga, e a mensagem precisa entrar mesmo assim. */
function withTimeout(promise, ms, mensagem) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(mensagem)), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
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
    this.lastHistoryImportAt = null;
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
      /* Última vez que o celular mandou um lote de mensagens antigas. Serve de
         prova visível de que o pedido funcionou. */
      lastHistoryImportAt: this.lastHistoryImportAt,
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
    /* O lote de mensagens antigas que o celular devolve (resposta ao pedido
       sob demanda, ou empurrão inicial de quem acabou de parear). */
    sock.ev.on("messaging-history.set", payload => {
      this.importarHistorico(payload).catch(error => this.errors.push(`Não consegui importar o histórico do WhatsApp: ${error.message || error}`));
    });
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
    await this.markConversationOpen(row.id);
    return this.getConversation(row.id);
  }

  async conversaPorTelefone(phone) {
    assertSupabase();
    const clean = normalizeWhatsAppPhone(phone);
    if (!clean) return null;
    const { data, error } = await supabase.from("whatsapp_conversations").select("*").eq("phone", clean).maybeSingle();
    if (error) throw databaseError(error, "Falha ao procurar a conversa pelo telefone.");
    return data || null;
  }

  /* A conversa tem pelo menos uma mensagem? É o que separa o cadastro certo de
     uma ficha fantasma: a que sobrou de um eco antigo fica vazia para sempre. */
  async conversaTemMensagens(id) {
    assertSupabase();
    if (!id) return false;
    const { data, error } = await supabase.from("whatsapp_messages").select("id").eq("conversation_id", id).limit(1);
    if (error) throw databaseError(error, "Falha ao contar as mensagens da conversa.");
    return (data || []).length > 0;
  }

  /* O mesmo celular pode estar cadastrado sem o 9º dígito (o Google costuma
     mostrar assim) enquanto o WhatsApp do cliente é o número com o 9 — ou vice
     versa. Se já existe uma conversa AQUELA com mensagens no número irmão, é
     ela que representa o cliente: abrir conversa para o número do cadastro era
     o que deixava o mesmo nome duas vezes no menu do WhatsApp. */
  async conversaIrmaComMensagens(phone) {
    const irma = await this.conversaIrma(phone);
    if (!irma) return null;
    return (await this.conversaTemMensagens(irma.id)) ? irma : null;
  }

  /* A ficha do número irmão, com ou sem mensagens. É a peça que fecha o bug que
     ele ainda vê na tela: o cliente responde pelo WhatsApp dele (com o 9) e o
     CRM, procurando apenas o número EXATO do cadastro, criava outra conversa —
     duas fichas do mesmo cliente no menu. Antes de INSERIR qualquer conversa,
     ensureConversation consulta primeiro esta função. */
  async conversaIrma(phone) {
    assertSupabase();
    const irma = irmaDoNove(normalizeWhatsAppPhone(phone) || phone);
    if (!irma) return null;
    const { data, error } = await supabase.from("whatsapp_conversations").select("*").eq("phone", irma).limit(1);
    if (error) throw databaseError(error, "Falha ao procurar a conversa do número irmão.");
    return (data || [])[0] || null;
  }

  /* Atendente abriu a conversa: "Novo" e "Respondido" passam a
     "Atendimento iniciado". Resolvido/Cancelado/Arquivado e "Aguardando
     resposta" são preservados — a abertura sozinha não reabre um caso encerrado. */
  async markConversationOpen(id) {
    assertSupabase();
    const { data: row, error } = await supabase.from("whatsapp_conversations").select("*").eq("id", id).maybeSingle();
    if (error) throw databaseError(error, "Falha ao consultar a conversa do WhatsApp.");
    if (!row) return null;
    const next = conversationStatus.nextOnOpen(row.status);
    /* Nada muda: só devolve a conversa (getConversation já zera o não lido). */
    if (next === conversationStatus.normalize(row.status)) return this.getConversation(id);
    const { error: updateError } = await supabase.from("whatsapp_conversations").update({ status: next, unread_count: 0 }).eq("id", id);
    if (updateError) throw databaseError(updateError, "Não foi possível marcar a conversa como em atendimento.");
    return this.getConversation(id);
  }

  /* Mudança manual do atendente pelo menu de status do chat. */
  async updateConversationStatus(id, status) {
    assertSupabase();
    const { data: row, error } = await supabase.from("whatsapp_conversations").select("id").eq("id", id).maybeSingle();
    if (error) throw databaseError(error, "Falha ao consultar a conversa do WhatsApp.");
    if (!row) return null;
    const { error: updateError } = await supabase.from("whatsapp_conversations").update({ status }).eq("id", id);
    if (updateError) throw databaseError(updateError, "Não foi possível atualizar o status da conversa.");
    return this.getConversation(id);
  }

  mapConversation(row, lastMessage = null) {
    return {
      id: row.id,
      contact: { name: row.contact_name || row.phone, phone: row.phone, company: row.company || "" },
      /* normalize() converte rótulos antigos (ex.: "Em atendimento",
         "Aguardando cliente") para o ciclo de vida atual sem precisar de
         migração de dados. */
      status: conversationStatus.normalize(row.status),
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
    return { ...this.mapConversation(row), messages: (messages || []).map(m => ({ id: m.id, direction: m.direction, content: m.content, timestamp: m.timestamp, status: m.status, sentBy: m.sent_by || null, hasAudio: incomingAudio.isAudioContent(m.content) })) };
  }

  /* O link do áudio é assinado agora, no clique, e não junto com a conversa: a
     conversa volta a ser lida a cada sincronização e cada assinatura é um pedido
     ao Supabase. */
  async getAudioUrl(conversationId, messageId) {
    assertSupabase();
    const { data: message, error } = await supabase
      .from("whatsapp_messages")
      .select("id, content")
      .eq("id", messageId)
      .eq("conversation_id", conversationId)
      .maybeSingle();
    if (error) throw databaseError(error, "Falha ao consultar a mensagem de áudio.");
    if (!message) throw new ApiError(404, "Esta mensagem não existe nesta conversa.");
    if (!incomingAudio.isAudioContent(message.content)) {
      throw new ApiError(404, "Esta mensagem não tem um áudio guardado. As vozes recebidas antes de o CRM aprender a ouvir não ficaram salvas — peça para o cliente mandar de novo.");
    }
    const url = await incomingAudio.signedUrlForObject(incomingAudio.objectPath(conversationId, messageId));
    if (!url) throw new ApiError(502, `O Supabase não devolveu o link do áudio. Confira se o bucket ${incomingAudio.bucketName()} existe no projeto.`);
    return { url };
  }

  async deleteConversation(id) {
    assertSupabase();
    const { data: row, error: findError } = await supabase.from("whatsapp_conversations").select("id, phone").eq("id", id).maybeSingle();
    if (findError) throw databaseError(findError, "Falha ao consultar a conversa do WhatsApp.");
    if (!row) return false;
    const { error } = await supabase.from("whatsapp_conversations").delete().eq("id", id);
    if (error) throw databaseError(error, "Não foi possível excluir a conversa do WhatsApp.");
    /* A conversa sumiu do banco; os áudios dela somem do Storage junto, e o JID
       que servia de âncora para pedir mensagens antigas perde o sentido. */
    chatJidStore.esquecerJid(row.phone);
    await incomingAudio.removeAudioFromConversation(id)
      .catch(error => console.warn("[audio] Não consegui limpar os áudios da conversa excluída:", error?.message || error));
    this.lastSyncAt = new Date().toISOString();
    return true;
  }

  async ensureConversation(phone, contactName = null, company = "") {
    const clean = normalizeWhatsAppPhone(phone);
    if (!clean) throw new ApiError(400, "O contato não tem um número de telefone válido para o WhatsApp.");
    const existing = await supabase.from("whatsapp_conversations").select("*").eq("phone", clean).maybeSingle();
    if (existing.error) throw databaseError(existing.error, "Falha ao consultar a conversa recebida.");
    let data = existing.data;
    /* A ficha EXATA pode existir e estar VAZIA: é ela que o número do cadastro
       criou, e ninguém nunca falou por aquele número. Se o irmão tem mensagens, é
       o irmão que representa o cliente — e a conversa do mesmo celular continuaria
       dividida em duas fichas, metade das mensagens de um lado, metade do outro. */
    if (data && !(await this.conversaTemMensagens(data.id))) {
      const irmaComMensagens = await this.conversaIrmaComMensagens(clean);
      if (irmaComMensagens) {
        console.log(`[whatsapp] A ficha ${clean} está vazia e o número irmão ${irmaComMensagens.phone} tem histórico: a mensagem vai para a que já tem conversa.`);
        data = irmaComMensagens;
      }
    }
    if (!data) {
      /* O número que chegou — resposta do cliente, eco do celular, lote de
         histórico — pode ser o irmão com/sem o 9º dígito da conversa que já
         está no CRM. Reaproveitar aquela é a regra: foi criar a linha nova a
         partir daqui que o mesmo cliente ficou em dois chats separados. */
      data = await this.conversaIrma(clean);
      if (data) {
        console.log(`[whatsapp] ${clean} é o mesmo celular de ${data.phone}: a mensagem entra na conversa que já existe, sem abrir segunda ficha.`);
        /* A irmã está VAZIA (zero mensagens): é ficha fantasma, nascida do número
           do cadastro, e ninguém nunca falou por aquele número. Quem tem tráfego
           de verdade é o número que acabou de chegar, então a ficha passa a levar
           este número — sobra uma ficha só, já com o número pelo qual o cliente
           realmente fala. Com mensagens na irmã nada é renomeado: a que tem
           histórico manda, e trocar o número a cada mensagem faria ele pular de
           um lado para o outro entre as duas formas do mesmo celular. */
        if (!(await this.conversaTemMensagens(data.id))) {
          const renomeada = await this.reancorarNumero(data.id, clean)
            .catch(error => {
              console.warn("[whatsapp] A mensagem entrou na conversa vazia da irmã, mas não consegui renomear o número dela:", error?.message || error);
              return false;
            });
          if (renomeada) {
            console.log(`[whatsapp] Ficha vazia ${data.phone} passou a ser ${clean}: o número do cadastro morreu, o atendimento continua na mesma conversa.`);
            data = { ...data, phone: clean };
          }
        }
      }
    }
    if (!data) {
      const created = await supabase.from("whatsapp_conversations").insert({ phone: clean, contact_name: contactName || clean, company, status: conversationStatus.DEFAULT_STATUS, unread_count: 0, updated_at: new Date().toISOString() }).select().single();
      if (created.error?.code === "23505") {
        /* Uma mensagem recebida pode criar a mesma conversa após o SELECT.
           A restrição única do telefone garante que a conversa existente pode
           ser reutilizada em vez de falhar ao abrir o lead. */
        const raced = await supabase.from("whatsapp_conversations").select("*").eq("phone", clean).maybeSingle();
        if (raced.error) throw databaseError(raced.error, "Falha ao consultar a conversa recebida.");
        if (!raced.data) throw databaseError(created.error, "Não foi possível criar a conversa no CRM.");
        data = raced.data;
      } else if (created.error) {
        console.error("[whatsapp] Não foi possível criar conversa.", {
          code: created.error.code || "unknown",
          message: created.error.message || "Erro do banco de dados sem mensagem.",
        });
        throw databaseError(created.error, "Não foi possível criar a conversa no CRM.");
      } else {
        data = created.data;
      }
    }
    if ((contactName && contactName !== data.contact_name) || (company && company !== data.company)) {
      const patch = {};
      if (contactName && contactName !== data.contact_name) patch.contact_name = contactName;
      if (company && company !== data.company) patch.company = company;
      const updated = await supabase.from("whatsapp_conversations").update(patch).eq("id", data.id);
      if (updated.error) throw databaseError(updated.error, "Não foi possível atualizar o contato da conversa.");
      Object.assign(data, patch);
    }
    return data;
  }

  /* para o envio: qual JID usar. O número do cadastro pode estar na outra forma
     do mesmo celular (com/sem o 9º dígito), e o WhatsApp responde "não
     encontrado" para a forma errada — enquanto o cliente manda mensagem pelo
     número dele normalmente. Então testamos o número da ficha, o irmão de 9º
     dígito e o JID visto na última mensagem deste contato, e enviamos pelo que
     o WhatsApp confirmar. */
  async resolverDestino(phone) {
    const candidatos = [phone];
    const irma = irmaDoNove(phone);
    if (irma) candidatos.push(irma);
    const guardado = chatJidStore.jidDe(phone);
    /* Só presta como sugestão de número o JID que é telefone (@s.whatsapp.net);
       LID (xxx@lid) não é número e não vai para o onWhatsApp. */
    if (guardado && guardado.endsWith("@s.whatsapp.net")) {
      const visto = jidToPhone(guardado);
      if (visto && !candidatos.includes(visto)) candidatos.push(visto);
    }
    const jids = candidatos.map(c => jidNormalizedUser(`${c}@s.whatsapp.net`));
    let matches;
    try {
      matches = await this.sock.onWhatsApp(jids.join(","));
    } catch (error) {
      throw new ApiError(502, `Não foi possível validar o número no WhatsApp. Tente novamente.${error?.message ? ` (${error.message})` : ""}`);
    }
    for (let i = 0; i < jids.length; i++) {
      const achou = (matches || []).find(match => match?.exists && jidToPhone(match.jid || "") === candidatos[i]);
      if (achou) {
        return {
          jid: jidNormalizedUser(achou.jid || jids[i]),
          phone: candidatos[i],
          daFicha: phone,
          trocou: candidatos[i] !== phone,
        };
      }
    }
    return null;
  }

  /* A ficha passa a mostrar o número pelo qual o WhatsApp realmente atende. Só
     faz isso quando não existe outra conversa naquele número: enquanto houver
     ficha duplicada, mexer no telefone criaria conflito no lugar do merge. */
  async reancorarNumero(id, novoPhone) {
    assertSupabase();
    const { data: jaTem, error: lookupError } = await supabase.from("whatsapp_conversations").select("id").eq("phone", novoPhone).limit(1);
    if (lookupError) throw databaseError(lookupError, "Falha ao conferir o número da conversa.");
    if ((jaTem || []).length) return false;
    const { error } = await supabase.from("whatsapp_conversations").update({ phone: novoPhone }).eq("id", id);
    if (error) throw databaseError(error, "A mensagem saiu, mas não consegui ajustar o número da conversa.");
    return true;
  }

  async sendText(id, content, sentBy) {
    assertSupabase();
    if (!this.sock || this.status !== "CONNECTED") throw new ApiError(409, "Conecte o WhatsApp via Baileys antes de enviar mensagens.");
    const { data: conversation, error: conversationError } = await supabase.from("whatsapp_conversations").select("*").eq("id", id).maybeSingle();
    if (conversationError) throw databaseError(conversationError, "Falha ao consultar o contato antes do envio.");
    if (!conversation) return null;
    const phone = normalizeWhatsAppPhone(conversation.phone);
    if (!phone) throw new ApiError(400, "O contato não tem um número de telefone válido para o WhatsApp.");
    const destino = await this.resolverDestino(phone);
    if (!destino) {
      throw new ApiError(400, "Este número não foi encontrado no WhatsApp. Confira o DDI, DDD e número cadastrado no lead.");
    }
    if (destino.trocou) {
      console.log(`[whatsapp] A ficha estava em ${phone}, mas a conta do cliente atende por ${destino.phone}; o envio sai por ele.`);
      await this.reancorarNumero(id, destino.phone)
        .catch(error => console.warn("[whatsapp] Enviei a mensagem, mas não consegui ajustar o número da conversa:", error?.message || error));
    }
    /* O ID é gerado ANTES de enviar e entregue ao Baileys. A cópia desta mensagem
       volta pelo messages.upsert (fromMe) quase junto com o retorno, e às vezes
       com outro JID — o WhatsApp devolve o número sem o 9º dígito, ou um LID no
       lugar do telefone. Se a linha já estiver gravada nesta conversa quando o eco
       chegar, o eco reaproveita a conversa certa em vez de abrir uma segunda para
       o mesmo cliente. */
    const messageId = generateMessageID();
    const timestamp = new Date().toISOString();
    const rascunho = await supabase.from("whatsapp_messages").insert({ id: messageId, conversation_id: id, direction: "outgoing", content, timestamp, status: "pending", sent_by: sentBy || null, provider_message_id: messageId });
    if (rascunho.error) throw databaseError(rascunho.error, "Não foi possível anotar a mensagem antes do envio.");
    let sent;
    try {
      sent = await this.sock.sendMessage(destino.jid, { text: content }, { messageId });
    } catch (error) {
      await supabase.from("whatsapp_messages").delete().eq("id", messageId);
      const reason = error?.message ? ` (${error.message})` : "";
      throw new ApiError(502, `O WhatsApp não aceitou o envio da mensagem${reason}.`);
    }
    chatJidStore.registrarJid(phone, destino.jid);
    if (destino.trocou) chatJidStore.registrarJid(destino.phone, destino.jid);
    /* Se o WhatsApp tiver usado outro ID, a linha passa a usar o ID dele — é com
       esse ID que o celular vai bater na porta de novo. */
    const idReal = sent?.key?.id || messageId;
    const initialStatus = messageStatusAfterSend(
      this.recentMessageStatuses.get(idReal) || sent?.status
    );
    /* Upsert, e não insert: vale tanto para atualizar o rascunho acima quanto para
       sobreviver a um eco que tenha chegado no meio do envio. */
    const { data: saved, error } = await supabase.from("whatsapp_messages").upsert({ id: idReal, conversation_id: id, direction: "outgoing", content, timestamp, status: initialStatus, sent_by: sentBy || null, provider_message_id: idReal }, { onConflict: "id" }).select().single();
    if (error) throw databaseError(error, "A mensagem foi enviada ao WhatsApp, mas não foi possível salvar o histórico.");
    if (idReal !== messageId) await supabase.from("whatsapp_messages").delete().eq("id", messageId);
    const receiptStatus = this.recentMessageStatuses.get(idReal);
    this.recentMessageStatuses.delete(idReal);
    if (receiptStatus && receiptStatus !== initialStatus) {
      const receiptUpdate = await supabase.from("whatsapp_messages").update({ status: receiptStatus }).eq("provider_message_id", idReal);
      if (receiptUpdate.error) throw databaseError(receiptUpdate.error, "Não foi possível salvar a confirmação de entrega da mensagem.");
    }
    const updated = await supabase.from("whatsapp_conversations").update({ status: conversationStatus.nextOnOutgoing(conversation.status), updated_at: timestamp }).eq("id", id);
    if (updated.error) throw databaseError(updated.error, "A mensagem foi enviada, mas não foi possível atualizar a conversa.");
    this.lastSyncAt = timestamp;
    return { id: saved.id, direction: saved.direction, content: saved.content, timestamp: saved.timestamp, status: saved.status, sentBy: saved.sent_by };
  }

  async sendMedia(id, { kind, buffer, mimeType, caption, sentBy }) {
    assertSupabase();
    if (!this.sock || this.status !== "CONNECTED") throw new ApiError(409, "Conecte o WhatsApp via Baileys antes de enviar arquivos.");
    const { data: conversation, error: conversationError } = await supabase.from("whatsapp_conversations").select("*").eq("id", id).maybeSingle();
    if (conversationError) throw databaseError(conversationError, "Falha ao consultar o contato antes do envio.");
    if (!conversation) return null;
    const phone = normalizeWhatsAppPhone(conversation.phone);
    if (!phone) throw new ApiError(400, "O contato não tem um número de telefone válido para o WhatsApp.");
    /* Mesmo caminho do envio de texto: pelo número da ficha, pelo irmão de 9º
       dígito ou pelo JID visto na última mensagem — vale o que o WhatsApp
       confirmar, e a conversa é sempre a mesma. */
    const destino = await this.resolverDestino(phone);
    if (!destino) throw new ApiError(400, "Este número não foi encontrado no WhatsApp. Confira o DDI, DDD e número cadastrado no lead.");
    if (destino.trocou) {
      await this.reancorarNumero(id, destino.phone)
        .catch(error => console.warn("[whatsapp] Enviei o arquivo, mas não consegui ajustar o número da conversa:", error?.message || error));
    }

    let payload;
    const content = caption || (kind === "image" ? "[Imagem enviada]" : "[Áudio enviado]");
    if (kind === "image") payload = { image: buffer, mimetype: mimeType, ...(caption ? { caption } : {}) };
    else {
      let audio;
      try {
        audio = await convertToOggOpus(buffer);
      } catch (error) {
        console.error("[whatsapp] Falha ao converter áudio:", error.message);
        throw new ApiError(422, "Não foi possível preparar o áudio para o WhatsApp. Tente outro arquivo de áudio.");
      }
      payload = {
        audio,
        mimetype: "audio/ogg; codecs=opus",
        ptt: kind === "voice",
      };
    }
    /* Mesmo cuidado do envio de texto: a linha nasce antes, com o ID que vamos
       usar no envio, para o eco do celular não abrir uma segunda conversa. */
    const messageId = generateMessageID();
    const timestamp = new Date().toISOString();
    const rascunho = await supabase.from("whatsapp_messages").insert({ id: messageId, conversation_id: id, direction: "outgoing", content, timestamp, status: "pending", sent_by: sentBy || null, provider_message_id: messageId });
    if (rascunho.error) throw databaseError(rascunho.error, "Não foi possível anotar o arquivo antes do envio.");
    let sent;
    try {
      sent = await this.sock.sendMessage(destino.jid, payload, { messageId });
    } catch (error) {
      await supabase.from("whatsapp_messages").delete().eq("id", messageId);
      const reason = error?.message ? ` (${error.message})` : "";
      throw new ApiError(502, `O WhatsApp não aceitou o envio do arquivo${reason}.`);
    }
    chatJidStore.registrarJid(phone, destino.jid);
    if (destino.trocou) chatJidStore.registrarJid(destino.phone, destino.jid);
    /* Se o WhatsApp usou outro ID, a linha passa a carregar o ID dele: é com esse
       ID que o celular bate de novo na porta. */
    const idReal = sent?.key?.id || messageId;
    const initialStatus = messageStatusAfterSend(
      this.recentMessageStatuses.get(idReal) || sent?.status
    );
    const { data: saved, error } = await supabase.from("whatsapp_messages").upsert({
      id: idReal,
      conversation_id: id,
      direction: "outgoing",
      content,
      timestamp,
      status: initialStatus,
      sent_by: sentBy || null,
      provider_message_id: idReal,
    }, { onConflict: "id" }).select().single();
    if (error) throw databaseError(error, "O arquivo foi enviado ao WhatsApp, mas não foi possível salvar o histórico.");
    if (idReal !== messageId) await supabase.from("whatsapp_messages").delete().eq("id", messageId);
    this.recentMessageStatuses.delete(idReal);
    const updated = await supabase.from("whatsapp_conversations").update({
      status: conversationStatus.nextOnOutgoing(conversation.status),
      updated_at: timestamp,
    }).eq("id", id);
    if (updated.error) throw databaseError(updated.error, "O arquivo foi enviado, mas não foi possível atualizar a conversa.");
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
      if (status === "pending") continue;
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

  /* O áudio que o CLIENTE manda era o que mais se perdia: o Baileys entrega o
     arquivo e o CRM gravava só o rótulo "[Áudio]", então ninguém ouvia nada
     pela tela e a IA sugeria resposta sem saber o que ele falou. Aqui o arquivo
     vai para o Supabase Storage e o texto da mensagem vira a transcrição.
     Nada aqui pode derrubar a mensagem: falhou o áudio, o "[Áudio]" continua
     na tela igual antes. */
  async armarAudioDoCliente(msg, conversationId, messageId) {
    const audio = msg?.message?.audioMessage;
    if (!audio) return null;
    const mimetype = String(audio.mimetype || "audio/ogg; codecs=opus");

    let buffer;
    try {
      buffer = await withTimeout(
        downloadMediaMessage(msg, "buffer", { maxByteLength: incomingAudio.MAX_AUDIO_BYTES }),
        45000,
        "o download do áudio do WhatsApp demorou demais",
      );
    } catch (error) {
      console.warn(`[audio] ${error?.message || "download falhou"} — a mensagem fica sem o arquivo.`);
      return null;
    }
    if (!buffer?.length) {
      console.warn("[audio] O WhatsApp devolveu o áudio vazio — a mensagem fica sem o arquivo.");
      return null;
    }

    const path = await incomingAudio.uploadAudio({ conversationId, messageId, buffer, mimetype });

    /* Música e áudio de arquivo (ptt = false) não viram fala: só a nota de voz
       do cliente é transcrita. */
    const ehNotaDeVoz = audio.ptt !== false;
    const transcricao = ehNotaDeVoz
      ? await incomingAudio.transcribeAudio(buffer, mimetype)
      : { text: "", reason: "não é nota de voz" };
    const content = incomingAudio.transcriptContent(transcricao.text);

    const { error } = await supabase.from("whatsapp_messages").update({ content }).eq("id", messageId);
    if (error) console.warn("[audio] Áudio guardado, mas não consegui trocar o texto da mensagem:", error.message);
    console.log(`[audio] Áudio do cliente em ${path}${transcricao.text ? ` — transcrito (${transcricao.text.length} caracteres, ${transcricao.model})` : ` — sem transcrição (${transcricao.reason})`}`);
    return { path, content };
  }

  async handleIncoming(upsert) {
    if (upsert?.type && !["notify", "append"].includes(upsert.type)) return;
    for (const msg of upsert?.messages || []) {
      /* Antes toda mensagem com key.fromMe era jogada fora, então o que ele
         digitava no APP do WhatsApp nunca aparecia no CRM. Agora ela entra como
         saída — a cópia chega pelo mesmo canal da recebida. */
      const gravada = await this.persistirMensagem(msg, { origem: "tempo-real" });
      if (!gravada || gravada.duplicada) continue;
      if (msg?.message?.audioMessage && !msg.key?.fromMe) {
        await this.armarAudioDoCliente(msg, gravada.conversationId, gravada.messageId)
          .catch(error => console.warn("[audio] Preparei mal o áudio recebido:", error?.message || error));
      }
    }
  }

  /* Uma mensagem do Baileys virando linha no banco, dos dois lados. `origem`
     separa o que está acontecendo agora do que é passado chegando em lote: só o
     "tempo-real" mexe no status do atendimento e conta como não lida. */
  async persistirMensagem(msg, { origem = "tempo-real", nomeDoContato = null } = {}) {
    assertSupabase();
    if (!msg?.message || !msg.key?.remoteJid) return null;
    /* Protocolo não é conversa: é o próprio pedido de histórico indo e vindo, e
       um "[Mensagem não textual]" na tela só confundiria o atendimento. */
    if (msg.message.protocolMessage) return null;
    const phone = incomingPhone(msg.key);
    if (!phone) return null;
    const enviada = Boolean(msg.key.fromMe);
    /* O papo do CRM com o PRÓPRIO número (os lembretes de follow-up que o
       backend manda para o celular dele) não é atendimento: sem esta linha cada
       aviso viraria uma conversa nova no menu do WhatsApp. */
    if (enviada && this.phoneNumber && phone === this.phoneNumber) return null;
    /* A linha desta mensagem já existe? Então a conversa dela já está decidida.
       Sem esta checagem, a cópia que o celular devolve de um envio do CRM — que
       às vezes volta com outro JID, porque o WhatsApp troca o número pelo LID ou
       pelo telefone sem o 9º dígito — criava uma conversa vazia para o mesmo
       cliente, e ele aparecia duas vezes no menu do WhatsApp. */
    const idDaMensagem = typeof msg.key?.id === "string" && msg.key.id ? msg.key.id : null;
    if (idDaMensagem) {
      const existente = await supabase.from("whatsapp_messages").select("conversation_id").eq("id", idDaMensagem).maybeSingle();
      if (existente.error) throw databaseError(existente.error, "Falha ao consultar a mensagem do WhatsApp.");
      if (existente.data) return { duplicada: true, conversationId: existente.data.conversation_id, messageId: idDaMensagem };
    }
    chatJidStore.registrarJid(phone, msg.key.remoteJid);

    const content = messageText(msg);
    const timestamp = timestampFromMessage(msg);
    /* Numa mensagem minha o pushName é o MEU nome, nunca o do cliente — por isso
       o nome só é aproveitado no lado recebido. */
    const conversa = await this.ensureConversation(
      phone,
      enviada ? nomeDoContato : (nomeDoContato || msg.pushName || phone)
    );
    const messageId = msg.key?.id || randomUUID();
    const linha = {
      id: messageId,
      conversation_id: conversa.id,
      direction: enviada ? "outgoing" : "incoming",
      content,
      timestamp,
      status: enviada ? messageStatusAfterSend(msg.status) : "delivered",
      sent_by: enviada ? ENVIADA_PELO_CELULAR : null,
      provider_message_id: msg.key?.id || null,
    };
    const inserida = await supabase.from("whatsapp_messages").insert(linha);
    if (inserida.error && inserida.error.code !== "23505") {
      throw databaseError(inserida.error, "Não foi possível salvar a mensagem do WhatsApp.");
    }
    /* 23505 = a mensagem já estava lá (cópia do que o próprio CRM enviou, ou um
       lote que se repetiu). Não se reescreve o sent_by nem se conta de novo. */
    if (inserida.error) return { duplicada: true, conversationId: conversa.id, messageId };

    const patch = {};
    if (origem === "tempo-real" && mensagemViva(timestamp)) {
      patch.status = enviada
        ? conversationStatus.nextOnOutgoing(conversa.status)
        : conversationStatus.nextOnIncoming(conversa.status);
      if (!enviada) patch.unread_count = (conversa.unread_count || 0) + 1;
      this.lastSyncAt = timestamp;
    }
    /* Histórico velho não puxa a conversa para o topo da lista; só uma atividade
       mais recente que a última registrada faz isso. */
    if ((Date.parse(timestamp) || 0) > (Date.parse(conversa.updated_at || "") || 0)) {
      patch.updated_at = timestamp;
    }
    if (Object.keys(patch).length) {
      const atualizado = await supabase.from("whatsapp_conversations").update(patch).eq("id", conversa.id);
      if (atualizado.error) throw databaseError(atualizado.error, "Não foi possível atualizar a conversa do WhatsApp.");
    }
    return { duplicada: false, conversationId: conversa.id, messageId, direction: linha.direction };
  }

  /* Lote de mensagens antigas que o celular devolveu. Chega fora de ordem e em
     vários pacotes; nada aqui reabre atendimento nem marca não lido. */
  async importarHistorico(payload) {
    const mensagens = Array.isArray(payload?.messages) ? payload.messages : [];
    const chats = Array.isArray(payload?.chats) ? payload.chats : [];
    const contatos = Array.isArray(payload?.contacts) ? payload.contacts : [];
    if (!mensagens.length && !chats.length) return null;
    assertSupabase();

    /* Nome que o celular dá ao contato: é melhor que o número puro. */
    const nomes = new Map();
    const registrarNome = (key, nome) => {
      const phone = incomingPhone({ remoteJid: key });
      if (phone && nome && !nomes.has(phone)) nomes.set(phone, String(nome).slice(0, 80));
    };
    for (const contato of contatos) registrarNome(contato?.id, contato?.name || contato?.notify);
    for (const chat of chats) registrarNome(chat?.id, chat?.name || chat?.displayName);

    let importadas = 0;
    let repetidas = 0;
    for (const msg of mensagens) {
      const phone = incomingPhone(msg?.key);
      const gravada = await this.persistirMensagem(msg, {
        origem: "historico",
        nomeDoContato: phone ? nomes.get(phone) : null,
      });
      if (!gravada) continue;
      if (gravada.duplicada) repetidas++;
      else importadas++;
    }
    this.lastHistoryImportAt = new Date().toISOString();
    console.log(`[historico] Importadas ${importadas} mensagens antigas (${repetidas} já estavam no CRM), de ${chats.length} conversa(s) no lote.`);
    return { importadas, repetidas, conversas: chats.length };
  }

  /* "Puxe as mensagens antigas desta conversa": o celular só entrega o que vem
     ANTES de uma mensagem que ele reconhece, então a âncora é a mensagem mais
     antiga que o CRM já tem. O retorno é o pedido; as mensagens chegam depois,
     pelo messaging-history.set. */
  async fetchConversationHistory(id, quantidade = 50) {
    assertSupabase();
    if (!this.sock || this.status !== "CONNECTED") {
      throw new ApiError(409, "Conecte o WhatsApp via Baileys antes de puxar as mensagens antigas.");
    }
    if (typeof this.sock.fetchMessageHistory !== "function") {
      throw new ApiError(503, "Esta versão do Baileys não sabe pedir mensagens antigas ao WhatsApp.");
    }
    const { data: conversa, error } = await supabase.from("whatsapp_conversations").select("*").eq("id", id).maybeSingle();
    if (error) throw databaseError(error, "Falha ao consultar a conversa do WhatsApp.");
    if (!conversa) return null;

    const { data: ancora, error: erroAncora } = await supabase
      .from("whatsapp_messages")
      .select("id, provider_message_id, direction, timestamp")
      .eq("conversation_id", id)
      .not("provider_message_id", "is", null)
      .order("timestamp", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (erroAncora) throw databaseError(erroAncora, "Falha ao consultar a mensagem mais antiga da conversa.");
    if (!ancora?.provider_message_id) {
      throw new ApiError(409, "O CRM ainda não tem nenhuma mensagem desta conversa, então não há o que pedir ao celular — mande ou receba uma mensagem nela primeiro.");
    }

    /* O JID real do chat, não o número: conversa identificada por LID
       simplesmente não responderia se pedíssemos pelo telefone. */
    const jid = chatJidStore.jidDe(conversa.phone)
      || jidNormalizedUser(`${normalizeWhatsAppPhone(conversa.phone)}@s.whatsapp.net`);
    const chave = {
      remoteJid: jid,
      fromMe: ancora.direction === "outgoing",
      id: ancora.provider_message_id,
    };
    const segundos = Math.floor(Date.parse(ancora.timestamp) / 1000);

    let pedido;
    try {
      pedido = await withTimeout(
        this.sock.fetchMessageHistory(quantidade, chave, segundos),
        30000,
        "o celular não respondeu ao pedido de mensagens antigas em 30 segundos",
      );
    } catch (error) {
      throw new ApiError(
        502,
        `O WhatsApp não aceitou mandar as mensagens antigas${error?.message ? ` (${error.message})` : ""}. Confira se o celular está com internet e com o WhatsApp aberto, e tente de novo.`
      );
    }
    console.log(`[historico] Pedi ao celular ${quantidade} mensagens anteriores de ${conversa.phone} (antes de ${ancora.timestamp}).`);
    return {
      conversationId: id,
      quantidade,
      ate: ancora.timestamp,
      requestId: typeof pedido === "string" ? pedido : null,
    };
  }

  async simulateIncomingMessage() { throw new ApiError(404, "A simulação foi removida. As mensagens reais entram pelo WhatsApp conectado via Baileys."); }
}

module.exports = BaileysWhatsAppProvider;
module.exports.incomingPhone = incomingPhone;
module.exports.messageStatusFromBaileys = messageStatusFromBaileys;
