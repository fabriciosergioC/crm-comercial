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

  /* Estado inicial do ciclo de vida: última mensagem de cada conversa define
     quem está aguardando (espelho da tabela de status do chat). */
  assert.equal(conversations[0].status, "Respondido");
  assert.equal(conversations[1].status, "Aguardando resposta");

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

  /* Enviou -> agora o CRM espera o cliente. */
  let current = await service.getConversation(conversations[0].id);
  assert.equal(current.status, "Aguardando resposta");

  /* A leitura da conversa NÃO muda o status (o poll do front lê a cada 2,5 s). */
  assert.equal(current.unreadCount, 0);

  /* O serviço bloqueia simulação de mensagem, então o provedor mock é usado
     diretamente para exercitar a chegada de mensagem do cliente. */
  const incoming = await provider.simulateIncomingMessage(conversations[0].id);
  assert.equal(incoming.direction, "incoming");
  assert.match(incoming.content, /resposta simulada/);

  /* Chegou mensagem do cliente -> precisa de ação do atendente. */
  current = await service.getConversation(conversations[0].id);
  assert.equal(current.status, "Respondido");
  assert.equal(current.unreadCount, 0);

  /* Atendente abriu a conversa -> atendimento iniciado. */
  const opened = await service.openConversation(conversations[0].id);
  assert.equal(opened.status, "Atendimento iniciado");

  /* Mudança manual pelo menu do chat. */
  const resolved = await service.updateStatus(conversations[0].id, "Resolvido");
  assert.equal(resolved.status, "Resolvido");
  assert.equal((await service.openConversation(conversations[0].id)).status, "Resolvido");
  const demoSent = await service.updateStatus(conversations[0].id, "Demo Enviada");
  assert.equal(demoSent.status, "Demo Enviada");
  assert.equal((await service.openConversation(conversations[0].id)).status, "Demo Enviada");
  assert.equal((await service.updateStatus(conversations[0].id, "Arquivado")).status, "Arquivado");

  await assert.rejects(
    service.updateStatus(conversations[0].id, "Encerrado"),
    error => error instanceof ApiError && error.status === 400
  );
  await assert.rejects(
    service.updateStatus("unknown", "Resolvido"),
    error => error instanceof ApiError && error.status === 404
  );
  await assert.rejects(
    service.openConversation("unknown"),
    error => error instanceof ApiError && error.status === 404
  );

  /* Rótulos antigos (antes da renomeação) continuam sendo entendidos,
     então rodar a migração 007 é opcional. */
  const { normalize } = require("../services/whatsapp/conversationStatus");
  assert.equal(normalize("Em atendimento"), "Atendimento iniciado");
  assert.equal(normalize("Aguardando cliente"), "Aguardando resposta");
  assert.equal(normalize("Aguardando atendente"), "Respondido");
  assert.equal(normalize("Aguardando resposta"), "Aguardando resposta");
  assert.equal(normalize("Respondido"), "Respondido");

  const conversation = await service.getConversation(conversations[0].id);
  assert.equal(conversation.messages.at(-2).content, "Teste mock");
  assert.equal(conversation.messages.at(-1).direction, "incoming");
  assert.equal(conversation.unreadCount, 0);
  assert.equal(conversation.status, "Arquivado");

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

    /* Menu de status do chat: PATCH muda o status e POST /open assume a
       conversa; status fora do ciclo de vida devolve 400. */
    const respondedResult = await request(`/conversations/${conversationId}/status`, "PATCH", { status: "Respondido" });
    assert.equal(respondedResult.response.status, 200);
    assert.equal(respondedResult.data.data.status, "Respondido");

    const patchResult = await request(`/conversations/${conversationId}/status`, "PATCH", { status: "Resolvido" });
    assert.equal(patchResult.response.status, 200);
    assert.equal(patchResult.data.data.status, "Resolvido");

    const invalidStatus = await request(`/conversations/${conversationId}/status`, "PATCH", { status: "Qualquer coisa" });
    assert.equal(invalidStatus.response.status, 400);

    const openResult = await request(`/conversations/${conversationId}/open`, "POST", {});
    assert.equal(openResult.response.status, 200);
    assert.equal(openResult.data.data.status, "Resolvido");
    assert.ok(Array.isArray(openResult.data.data.messages));

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
