"use strict";

const { randomUUID } = require("node:crypto");
const WhatsAppProvider = require("./WhatsAppProvider");
const { ApiError } = require("../../middleware/errorHandler");
const { isValid, nextOnIncoming, nextOnOpen, nextOnOutgoing, normalize } = require("./conversationStatus");
const { irmaDoNove } = require("./phoneUtils");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createSeedConversations() {
  const now = Date.now();
  return [
    {
      id: "mock-conversation-clinica",
      contact: {
        name: "Mariana Costa",
        phone: "5531999990001",
        company: "Clínica Vida"
      },
      status: "Respondido",
      unreadCount: 1,
      messages: [
        {
          id: "mock-message-clinica-1",
          direction: "incoming",
          content: "Olá, gostaria de saber mais sobre os serviços.",
          timestamp: new Date(now - 12 * 60 * 1000).toISOString(),
          status: "read"
        },
        {
          id: "mock-message-clinica-2",
          direction: "outgoing",
          content: "Olá, Mariana! Como posso ajudar?",
          timestamp: new Date(now - 9 * 60 * 1000).toISOString(),
          status: "read"
        },
        {
          id: "mock-message-clinica-3",
          direction: "incoming",
          content: "Queria conhecer melhor a solução para a clínica.",
          timestamp: new Date(now - 3 * 60 * 1000).toISOString(),
          status: "delivered"
        }
      ]
    },
    {
      id: "mock-conversation-oficina",
      contact: {
        name: "Rafael Mendes",
        phone: "5531999990002",
        company: "Oficina Central"
      },
      status: "Aguardando resposta",
      unreadCount: 0,
      messages: [
        {
          id: "mock-message-oficina-1",
          direction: "outgoing",
          content: "Bom dia, Rafael! Podemos conversar sobre a presença digital da oficina?",
          timestamp: new Date(now - 60 * 60 * 1000).toISOString(),
          status: "sent"
        }
      ]
    }
  ];
}

class MockWhatsAppProvider extends WhatsAppProvider {
  constructor() {
    super();
    this.status = "DISCONNECTED";
    this.lastSyncAt = null;
    this.conversations = createSeedConversations();
  }

  async getStatus() {
    return {
      provider: "mock",
      mode: "simulation",
      status: this.status,
      phoneNumber: this.status === "CONNECTED" ? "5531999991234" : null,
      accountName: this.status === "CONNECTED" ? "Conta de demonstração" : null,
      lastSyncAt: this.lastSyncAt,
      pendingMessages: 0,
      errors: [],
      qrCode: null,
      qrAvailable: false
    };
  }

  async connect() {
    this.status = "CONNECTED";
    this.lastSyncAt = new Date().toISOString();
    return this.getStatus();
  }

  async disconnect() {
    this.status = "DISCONNECTED";
    return this.getStatus();
  }

  async listConversations() {
    return clone(this.conversations.map(conversation => {
      const lastMessage = conversation.messages[conversation.messages.length - 1] || null;
      return {
        id: conversation.id,
        contact: conversation.contact,
        status: normalize(conversation.status),
        unreadCount: conversation.unreadCount,
        lastMessage
      };
    }));
  }

  /* Os dois métodos que o WhatsAppService usa para não abrir uma segunda
     conversa quando o cadastro tem o número sem o 9º dígito. No mock é a mesma
     regra, só que em memória. */
  async conversaPorTelefone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    return this.conversations.find(item => item.contact.phone.replace(/\D/g, "") === digits) || null;
  }

  async conversaTemMensagens(id) {
    return Boolean(this.conversations.find(item => item.id === id)?.messages?.length);
  }

  async conversaIrmaComMensagens(phone) {
    const irma = await this.conversaIrma(phone);
    if (!irma) return null;
    return (await this.conversaTemMensagens(irma.id)) ? irma : null;
  }

  /* Irmã de 9º dígito, com ou sem mensagens — igual ao provider do Baileys: é o
     que impede a resposta do cliente de virar segunda conversa no menu. */
  async conversaIrma(phone) {
    const irma = irmaDoNove(phone);
    if (!irma) return null;
    return this.conversations.find(item => item.contact.phone.replace(/\D/g, "") === irma) || null;
  }

  async openLeadConversation(lead) {
    const phone = String(lead.phone || "").replace(/\D/g, "");
    const exata = this.conversations.find(item => item.contact.phone.replace(/\D/g, "") === phone);
    let existing = exata || await this.conversaIrma(phone);
    /* Ficha exata VAZIA + irmã com histórico: a irmã vence, senão o mesmo
       cliente fica com as mensagens divididas em duas fichas. */
    if (exata && !(await this.conversaTemMensagens(exata.id))) {
      const irmaComMensagens = await this.conversaIrmaComMensagens(phone);
      if (irmaComMensagens) existing = irmaComMensagens;
    }
    if (existing) {
      /* Espelho do provider do Baileys: quando a mensagem/atendimento cai numa
         ficha irmã SEM nenhuma mensagem, a ficha passa a levar o número que está
         em uso, e não o número morto do cadastro. Com histórico na irmã, nada é
         trocado — a que tem mensagens manda. */
      if (!exata && !(await this.conversaTemMensagens(existing.id))) {
        existing.contact.phone = phone;
      }
      existing.contact.name = lead.contactName || existing.contact.name;
      existing.contact.company = lead.company || existing.contact.company;
      existing.unreadCount = 0;
      existing.status = nextOnOpen(existing.status);
      return clone(existing);
    }

    const conversation = {
      id: `mock-conversation-${randomUUID()}`,
      contact: { name: lead.contactName || phone, phone, company: lead.company || "" },
      status: "Atendimento iniciado",
      unreadCount: 0,
      messages: []
    };
    this.conversations.unshift(conversation);
    this.lastSyncAt = new Date().toISOString();
    return clone(conversation);
  }

  /* Atendente abriu a conversa: "Novo" e "Respondido" viram
     "Atendimento iniciado"; estados escolhidos à mão são preservados. */
  async markConversationOpen(id) {
    const conversation = this.conversations.find(item => item.id === id);
    if (!conversation) return null;
    conversation.status = nextOnOpen(conversation.status);
    conversation.unreadCount = 0;
    this.lastSyncAt = new Date().toISOString();
    return clone(conversation);
  }

  /* Mudança manual feita pelo atendente no menu do chat. */
  async updateConversationStatus(id, status) {
    const conversation = this.conversations.find(item => item.id === id);
    if (!conversation) return null;
    if (!isValid(status)) return null;
    conversation.status = status;
    this.lastSyncAt = new Date().toISOString();
    return clone(conversation);
  }

  async deleteConversation(id) {
    const index = this.conversations.findIndex(item => item.id === id);
    if (index < 0) return false;
    this.conversations.splice(index, 1);
    this.lastSyncAt = new Date().toISOString();
    return true;
  }

  async getConversation(id) {
    const conversation = this.conversations.find(item => item.id === id);
    if (!conversation) return null;
    conversation.unreadCount = 0;
    return clone(conversation);
  }

  /* No modo de teste não entra áudio real do WhatsApp: as mensagens simuladas
     são texto, então não há arquivo para tocar. */
  async getAudioUrl() {
    throw new ApiError(404, "No modo de teste não há áudio de cliente para tocar.");
  }

  /* Idem: sem celular pareado não existe histórico do WhatsApp para pedir. */
  async fetchConversationHistory() {
    throw new ApiError(404, "No modo de teste não há mensagens antigas do WhatsApp para puxar.");
  }

  async sendText(id, content, sentBy) {
    const conversation = this.conversations.find(item => item.id === id);
    if (!conversation) return null;

    const message = {
      id: randomUUID(),
      direction: "outgoing",
      content,
      timestamp: new Date().toISOString(),
      status: "sent",
      sentBy
    };
    conversation.messages.push(message);
    conversation.status = nextOnOutgoing(conversation.status);
    this.lastSyncAt = message.timestamp;
    return clone(message);
  }

  async sendMedia(id, { kind, caption, sentBy }) {
    const conversation = this.conversations.find(item => item.id === id);
    if (!conversation) return null;
    const message = {
      id: randomUUID(),
      direction: "outgoing",
      content: caption || (kind === "image" ? "[Imagem enviada]" : "[Áudio enviado]"),
      timestamp: new Date().toISOString(),
      status: "sent",
      sentBy,
    };
    conversation.messages.push(message);
    conversation.status = nextOnOutgoing(conversation.status);
    this.lastSyncAt = message.timestamp;
    return clone(message);
  }

  async sendNotification(phone, text) {
    if (this.status !== "CONNECTED") return null;
    console.log(`[mock-whatsapp] Aviso para ${phone}: ${text}`);
    this.lastSyncAt = new Date().toISOString();
    return { phone: String(phone || "").replace(/\D/g, ""), status: "sent" };
  }

  async simulateIncomingMessage(id) {
    const conversation = this.conversations.find(item => item.id === id);
    if (!conversation) return null;

    const message = {
      id: randomUUID(),
      direction: "incoming",
      content: "Obrigado! Recebi sua mensagem. (resposta simulada)",
      timestamp: new Date().toISOString(),
      status: "delivered"
    };
    conversation.messages.push(message);
    conversation.status = nextOnIncoming(conversation.status);
    conversation.unreadCount += 1;
    this.lastSyncAt = message.timestamp;
    return clone(message);
  }
}

module.exports = MockWhatsAppProvider;
