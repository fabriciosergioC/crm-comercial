"use strict";

const express = require("express");
const router = express.Router();
const whatsappService = require("../services/whatsapp/WhatsAppService");
const { generateSpeech, listVoiceProfiles } = require("../services/ttsService");


/* Lista os perfis de voz ("Rápida" / "Natural") para o seletor do chat. */
router.get("/tts/profiles", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({ success: true, data: listVoiceProfiles() });
  } catch (error) { next(error); }
});

/* Gera uma prévia de voz IA e devolve MP3 para reprodução no navegador. */
router.post("/tts/preview", async (req, res, next) => {
  try {
    const audio = await generateSpeech(req.body?.text, req.body?.profile);
    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audio.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.status(200).send(audio);
  } catch (error) { next(error); }
});

router.get("/status", async (req, res, next) => {
  try { res.set("Cache-Control", "no-store"); res.json({ success: true, data: await whatsappService.getStatus() }); } catch (error) { next(error); }
});

router.post("/connect", async (req, res, next) => {
  try {
    const phoneNumber = typeof req.body?.phoneNumber === "string" ? req.body.phoneNumber : "";
    res.json({ success: true, data: await whatsappService.connect({ phoneNumber }) });
  } catch (error) { next(error); }
});

router.post("/disconnect", async (req, res, next) => {
  try { res.json({ success: true, data: await whatsappService.disconnect() }); } catch (error) { next(error); }
});

router.get("/conversations", async (req, res, next) => {
  try { res.set("Cache-Control", "no-store"); res.json({ success: true, data: await whatsappService.listConversations() }); } catch (error) { next(error); }
});

router.post("/conversations/lead/:leadId", async (req, res, next) => {
  try { res.status(200).json({ success: true, data: await whatsappService.openLeadConversation(req.params.leadId) }); } catch (error) { next(error); }
});

router.delete("/conversations/:id", async (req, res, next) => {
  try { res.json({ success: true, data: await whatsappService.deleteConversation(req.params.id) }); } catch (error) { next(error); }
});

router.get("/conversations/:id", async (req, res, next) => {
  try { res.set("Cache-Control", "no-store"); res.json({ success: true, data: await whatsappService.getConversation(req.params.id) }); } catch (error) { next(error); }
});

/* POST /conversations/:id/open — atendente abriu a conversa.
   Dispara a transição de abertura (Novo / Respondido ->
   Atendimento iniciado) e devolve a conversa atualizada. */
router.post("/conversations/:id/open", async (req, res, next) => {
  try { res.set("Cache-Control", "no-store"); res.json({ success: true, data: await whatsappService.openConversation(req.params.id) }); } catch (error) { next(error); }
});

/* PATCH /conversations/:id/status   { status }
   Mudança manual feita pelo atendente no menu de status do chat.
   Só aceita os estados do ciclo de vida (400 caso contrário). */
router.patch("/conversations/:id/status", async (req, res, next) => {
  try {
    const status = typeof req.body?.status === "string" ? req.body.status : "";
    res.set("Cache-Control", "no-store");
    res.json({ success: true, data: await whatsappService.updateStatus(req.params.id, status) });
  } catch (error) { next(error); }
});

router.post("/conversations/:id/messages", async (req, res, next) => {
  try {
    const message = await whatsappService.sendText(req.params.id, req.body?.content, typeof req.body?.sentBy === "string" ? req.body.sentBy.slice(0, 80) : "Usuário");
    res.status(201).json({ success: true, data: message });
  } catch (error) { next(error); }
});

router.post(
  "/conversations/:id/messages/media",
  express.raw({ type: ["image/*", "audio/*"], limit: "8mb" }),
  async (req, res, next) => {
    try {
      const message = await whatsappService.sendMedia(req.params.id, {
        kind: req.query.kind,
        buffer: req.body,
        mimeType: req.get("Content-Type")?.split(";")[0].trim().toLowerCase(),
        caption: typeof req.query.caption === "string" ? req.query.caption : "",
        sentBy: typeof req.query.sentBy === "string" ? req.query.sentBy.slice(0, 80) : "Usuário",
      });
      res.status(201).json({ success: true, data: message });
    } catch (error) { next(error); }
  }
);

module.exports = router;
