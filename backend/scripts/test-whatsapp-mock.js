#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const MockWhatsAppProvider = require("../services/whatsapp/MockWhatsAppProvider");
const WhatsAppService = require("../services/whatsapp/WhatsAppService").WhatsAppService;
const { ApiError } = require("../middleware/errorHandler");

async function main() {
  const provider = new MockWhatsAppProvider();
  const service = new WhatsAppService(provider);

  const disconnected = await service.getStatus();
  assert.equal(disconnected.mode, "simulation");
  assert.equal(disconnected.status, "DISCONNECTED");

  const conversations = await service.listConversations();
  assert.equal(conversations.length, 2);
  assert.ok(conversations[0].lastMessage);

  await assert.rejects(
    service.sendText(conversations[0].id, "Mensagem antes de conectar", "tester"),
    error => error instanceof ApiError && error.status === 409
  );

  const connected = await service.connect();
  assert.equal(connected.status, "CONNECTED");
  assert.equal(connected.qrAvailable, false);

  await assert.rejects(
    service.sendText(conversations[0].id, "   ", "tester"),
    error => error instanceof ApiError && error.status === 400
  );
  await assert.rejects(
    service.sendText(conversations[0].id, "x".repeat(4001), "tester"),
    error => error instanceof ApiError && error.status === 400
  );

  const sent = await service.sendText(conversations[0].id, "Teste mock", "tester");
  assert.equal(sent.direction, "outgoing");
  assert.equal(sent.status, "sent");
  assert.equal(sent.content, "Teste mock");

  const incoming = await service.simulateIncomingMessage(conversations[0].id);
  assert.equal(incoming.direction, "incoming");
  assert.match(incoming.content, /resposta simulada/);

  const conversation = await service.getConversation(conversations[0].id);
  assert.equal(conversation.messages.at(-2).content, "Teste mock");
  assert.equal(conversation.messages.at(-1).direction, "incoming");
  assert.equal(conversation.unreadCount, 0);

  await assert.rejects(
    service.getConversation("unknown"),
    error => error instanceof ApiError && error.status === 404
  );

  const disconnectedAgain = await service.disconnect();
  assert.equal(disconnectedAgain.status, "DISCONNECTED");

  const app = require("../server");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/whatsapp`;
    const pageResponse = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /Gestão Comercial/);

    const request = async (path, method = "GET", body) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      return { response, data: await response.json() };
    };

    const statusResult = await request("/status");
    assert.equal(statusResult.response.status, 200);
    assert.equal(statusResult.data.data.provider, "mock");

    const connectResult = await request("/connect", "POST", {});
    assert.equal(connectResult.data.data.status, "CONNECTED");

    const listResult = await request("/conversations");
    assert.equal(listResult.data.data.length, 2);
    const conversationId = listResult.data.data[0].id;

    const sendResult = await request(
      `/conversations/${conversationId}/messages`,
      "POST",
      { content: "Mensagem via rota", sentBy: "tester" }
    );
    assert.equal(sendResult.response.status, 201);
    assert.equal(sendResult.data.data.content, "Mensagem via rota");

    const disconnectResult = await request("/disconnect", "POST", {});
    assert.equal(disconnectResult.data.data.status, "DISCONNECTED");
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }

  console.log("OK: provider mock, endpoints, conexão, mensagens e validações.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
