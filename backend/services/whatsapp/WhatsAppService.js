"use strict";

const { ApiError } = require("../../middleware/errorHandler");
const leadsService = require("../leadsService");
const { normalizeWhatsAppPhone } = require("./phoneUtils");
const conversationStatus = require("./conversationStatus");
const WhatsAppProvider = require("./WhatsAppProvider");
const MockWhatsAppProvider = require("./MockWhatsAppProvider");

function createProvider() {
  const provider = process.env.WHATSAPP_PROVIDER || "baileys";
  if (provider === "mock") return new MockWhatsAppProvider();
  if (provider === "baileys" && process.env.VERCEL === "1") {
    return new VercelWhatsAppProvider();
  }
  if (provider === "baileys") {
    const BaileysWhatsAppProvider = require("./BaileysWhatsAppProvider");
    return new BaileysWhatsAppProvider();
  }
  throw new ApiError(503, "Provider de WhatsApp inválido. Use baileys ou mock.");
}

class VercelWhatsAppProvider extends WhatsAppProvider {
  unavailable() {
    throw new ApiError(503, "A API de dados está hospedada na Vercel, mas a conexão WhatsApp via Baileys requer um backend Node.js persistente.");
  }
  getStatus() { return this.unavailable(); }
  connect() { return this.unavailable(); }
  disconnect() { return this.unavailable(); }
  listConversations() { return this.unavailable(); }
  openLeadConversation() { return this.unavailable(); }
  getConversation() { return this.unavailable(); }
  sendText() { return this.unavailable(); }
  sendMedia() { return this.unavailable(); }
  getAudioUrl() { return this.unavailable(); }
  fetchConversationHistory() { return this.unavailable(); }
  sendNotification() { return this.unavailable(); }
  deleteConversation() { return this.unavailable(); }
  markConversationOpen() { return this.unavailable(); }
  updateConversationStatus() { return this.unavailable(); }
  simulateIncomingMessage() { return this.unavailable(); }
}

class WhatsAppService {
  constructor(provider = createProvider()) { this.provider = provider; }
  getStatus() { return this.provider.getStatus(); }
  connect(options) { return this.provider.connect(options); }
  disconnect() { return this.provider.disconnect(); }
  listConversations() { return this.provider.listConversations(); }
  async openLeadConversation(leadId) {
    const lead = await leadsService.getById(leadId);
    const phone = [lead.whatsapp, lead.phone].map(normalizeWhatsAppPhone).find(Boolean);
    if (!phone) {
      throw new ApiError(400, "Este lead não tem um número de WhatsApp ou telefone válido cadastrado.");
    }
    /* O lead pode ter o número sem o 9º dígito enquanto o WhatsApp do cliente é
       o com o 9 (ou o contrário). Se a conversa com mensagens já existe no
       número irmão, é nela que o atendimento acontece — abrir conversa para o
       número do cadastro duplicava o cliente no menu. Uma conversa VAZIA no
       número do lead também não segura a troca: ficha fantasma não é atendimento. */
    let destino = phone;
    const propria = await this.provider.conversaPorTelefone?.(phone);
    const propriaTemMensagens = propria ? await this.provider.conversaTemMensagens?.(propria.id) : false;
    if (!propriaTemMensagens) {
      const irma = await this.provider.conversaIrmaComMensagens?.(phone);
      if (irma?.phone && irma.phone !== phone) {
        destino = irma.phone;
        await leadsService.update(leadId, { whatsapp: irma.phone })
          .catch(error => console.warn("[whatsapp] Achei a conversa no número irmão, mas não consegui corrigir o lead:", error?.message || error));
        console.log(`[whatsapp] Lead ${leadId}: conversa encontrada em ${irma.phone} (o cadastro tinha ${phone}); número do lead corrigido.`);
      }
    }
    return this.provider.openLeadConversation({
      phone: destino,
      contactName: lead.contactName || lead.company || destino,
      company: lead.company || "",
    });
  }
  async getConversation(id) {
    const conversation = await this.provider.getConversation(id);
    if (!conversation) throw new ApiError(404, "Conversa não encontrada.");
    return conversation;
  }
  /* Áudio que o cliente mandou: a URL assinada do Supabase sai aqui, no primeiro
     clique em Tocar, e não junto com a conversa (que é recarregada o tempo todo). */
  async getAudioUrl(id, messageId) {
    if (typeof messageId !== "string" || !messageId.trim()) {
      throw new ApiError(400, "Diga qual mensagem de voz você quer ouvir.");
    }
    const resultado = await this.provider.getAudioUrl(id, messageId.trim());
    if (!resultado?.url) throw new ApiError(404, "Não encontramos o áudio desta mensagem.");
    return resultado;
  }

  /* Pedido de mensagens antigas ao celular. A quantidade é cortada porque o
     WhatsApp responde em lote e um pedido enorme travaria a fila do pareamento. */
  async fetchConversationHistory(id, quantidade = 50) {
    const numero = Math.round(Number(quantidade) || 50);
    if (!Number.isFinite(numero) || numero < 1 || numero > 200) {
      throw new ApiError(400, "Peça entre 1 e 200 mensagens antigas por vez.");
    }
    const resultado = await this.provider.fetchConversationHistory(id, numero);
    if (!resultado) throw new ApiError(404, "Conversa não encontrada.");
    return resultado;
  }
  /* Atendente abriu a conversa: aplica a transição de abertura
     (Novo / Respondido -> Atendimento iniciado) e devolve a conversa. */
  async openConversation(id) {
    const conversation = await this.provider.markConversationOpen(id);
    if (!conversation) throw new ApiError(404, "Conversa não encontrada.");
    return conversation;
  }
  /* Mudança manual do status no menu do chat — só aceita os estados do
     ciclo de vida; qualquer outro valor é rejeitado antes de tocar no dado. */
  async updateStatus(id, status) {
    if (!conversationStatus.isValid(status)) {
      throw new ApiError(400, `Status inválido. Escolha um destes: ${conversationStatus.STATUSES.join(", ")}.`);
    }
    const conversation = await this.provider.updateConversationStatus(id, status);
    if (!conversation) throw new ApiError(404, "Conversa não encontrada.");
    return conversation;
  }
  async sendText(id, content, sentBy) {
    if (typeof content !== "string" || !content.trim()) throw new ApiError(400, "Digite uma mensagem antes de enviar.");
    if (content.length > 4000) throw new ApiError(400, "A mensagem não pode ultrapassar 4.000 caracteres.");
    const status = await this.provider.getStatus();
    if (status.status !== "CONNECTED") throw new ApiError(409, "Conecte o WhatsApp via Baileys antes de enviar mensagens.");
    const message = await this.provider.sendText(id, content.trim(), sentBy);
    if (!message) throw new ApiError(404, "Conversa não encontrada.");
    return message;
  }
  async sendMedia(id, { kind, buffer, mimeType, caption = "", sentBy }) {
    const allowedTypes = {
      image: new Set(["image/jpeg", "image/png", "image/webp"]),
      audio: new Set(["audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm", "audio/wav", "audio/x-wav", "audio/aac"]),
      voice: new Set(["audio/ogg", "audio/mpeg", "audio/mp4", "audio/webm", "audio/wav", "audio/x-wav", "audio/aac"]),
    };
    if (!allowedTypes[kind] || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new ApiError(400, "Anexo inválido. Escolha uma imagem ou um arquivo de áudio.");
    }
    if (!allowedTypes[kind].has(mimeType)) {
      throw new ApiError(400, kind === "image"
        ? "Formato de imagem não suportado. Use JPEG, PNG ou WebP."
        : "Formato de áudio não suportado.");
    }
    if (buffer.length > 8 * 1024 * 1024) {
      throw new ApiError(413, "O arquivo excede o limite de 8 MB.");
    }
    if (typeof caption !== "string" || caption.length > 4000) {
      throw new ApiError(400, "A legenda não pode ultrapassar 4.000 caracteres.");
    }
    const status = await this.provider.getStatus();
    if (status.status !== "CONNECTED") throw new ApiError(409, "Conecte o WhatsApp via Baileys antes de enviar arquivos.");
    const message = await this.provider.sendMedia(id, { kind, buffer, mimeType, caption: caption.trim(), sentBy });
    if (!message) throw new ApiError(404, "Conversa não encontrada.");
    return message;
  }
  async sendNotification(phone, text) {
    if (typeof text !== "string" || !text.trim()) throw new ApiError(400, "Texto do aviso vazio.");
    if (text.length > 4000) throw new ApiError(400, "O aviso não pode ultrapassar 4.000 caracteres.");
    const status = await this.provider.getStatus();
    if (status.status !== "CONNECTED") throw new ApiError(409, "Conecte o WhatsApp via Baileys antes de enviar avisos.");
    return this.provider.sendNotification(phone, text.trim());
  }
  async deleteConversation(id) {
    const removed = await this.provider.deleteConversation(id);
    if (!removed) throw new ApiError(404, "Conversa não encontrada.");
    return { id };
  }
  async simulateIncomingMessage() { throw new ApiError(404, "A simulação foi removida. Use um WhatsApp real conectado."); }
}

module.exports = new WhatsAppService();
module.exports.WhatsAppService = WhatsAppService;
