"use strict";

const { ApiError } = require("../../middleware/errorHandler");
const leadsService = require("../leadsService");
const { normalizeWhatsAppPhone } = require("./phoneUtils");
const MockWhatsAppProvider = require("./MockWhatsAppProvider");
const BaileysWhatsAppProvider = require("./BaileysWhatsAppProvider");

function createProvider() {
  const provider = process.env.WHATSAPP_PROVIDER || "baileys";
  if (provider === "mock") return new MockWhatsAppProvider();
  if (provider === "baileys") return new BaileysWhatsAppProvider();
  throw new ApiError(503, "Provider de WhatsApp inválido. Use baileys ou mock.");
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
    return this.provider.openLeadConversation({
      phone,
      contactName: lead.contactName || lead.company || phone,
      company: lead.company || "",
    });
  }
  async getConversation(id) {
    const conversation = await this.provider.getConversation(id);
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
  async simulateIncomingMessage() { throw new ApiError(404, "A simulação foi removida. Use um WhatsApp real conectado."); }
}

module.exports = new WhatsAppService();
module.exports.WhatsAppService = WhatsAppService;
