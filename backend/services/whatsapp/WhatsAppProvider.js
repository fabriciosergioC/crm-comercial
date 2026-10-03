"use strict";

class WhatsAppProvider {
  getStatus() {
    throw new Error("getStatus() must be implemented by the WhatsApp provider.");
  }

  connect() {
    throw new Error("connect() must be implemented by the WhatsApp provider.");
  }

  disconnect() {
    throw new Error("disconnect() must be implemented by the WhatsApp provider.");
  }

  listConversations() {
    throw new Error("listConversations() must be implemented by the WhatsApp provider.");
  }

  openLeadConversation() {
    throw new Error("openLeadConversation() must be implemented by the WhatsApp provider.");
  }

  getConversation() {
    throw new Error("getConversation() must be implemented by the WhatsApp provider.");
  }

  sendText() {
    throw new Error("sendText() must be implemented by the WhatsApp provider.");
  }

  deleteConversation() {
    throw new Error("deleteConversation() must be implemented by the WhatsApp provider.");
  }

  simulateIncomingMessage() {
    throw new Error("simulateIncomingMessage() must be implemented by the WhatsApp provider.");
  }
}

module.exports = WhatsAppProvider;
