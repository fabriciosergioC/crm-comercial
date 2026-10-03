"use strict";

const express = require("express");
const router = express.Router();
const whatsappService = require("../services/whatsapp/WhatsAppService");

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

router.post("/conversations/:id/messages", async (req, res, next) => {
  try {
    const message = await whatsappService.sendText(req.params.id, req.body?.content, typeof req.body?.sentBy === "string" ? req.body.sentBy.slice(0, 80) : "Usuário");
    res.status(201).json({ success: true, data: message });
  } catch (error) { next(error); }
});

module.exports = router;
