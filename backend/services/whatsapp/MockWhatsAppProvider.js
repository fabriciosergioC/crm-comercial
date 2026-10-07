"use strict";

const { randomUUID } = require("node:crypto");
const WhatsAppProvider = require("./WhatsAppProvider");
const { isValid, nextOnIncoming, nextOnOpen, nextOnOutgoing, normalize } = require("./conversationStatus");

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

  async openLeadConversation(lead) {
    const phone = String(lead.phone || "").replace(/\D/g, "");
    const existing = this.conversations.find(item => item.contact.phone.replace(/\D/g, "") === phone);
    if (existing) {
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
