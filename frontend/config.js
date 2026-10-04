// ============================================================================
//  Configuração da API do CRM
// ============================================================================
//  Arquitetura de produção (A): frontend estático na Vercel + API/Baileys na VPS.
//
//    Produção  -> https://api.crm-comercial.com/api   (VPS: nginx + TLS + systemd)
//    Local     -> http://localhost:3001/api           (run-crm.bat / node backend/server.js)
//
//  A detecção abaixo evita que o desenvolvimento local caia na API de produção:
//  em localhost/file:// as variáveis ficam vazias e o front usa a lógica
//  padrão de getApiBaseUrl() (mesma origem / localhost:3001).
// ============================================================================
const CRM_PROD_API_URL = "https://api.crm-comercial.com/api";

const CRM_IS_LOCAL =
  typeof window !== "undefined" &&
  (window.location.protocol === "file:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "");

// Base da API (leads, auth, propostas, enriquecimento...)
window.CRM_API_URL = CRM_IS_LOCAL ? "" : CRM_PROD_API_URL;

// Base específica do WhatsApp. Mesma URL nesta arquitetura, mas declarada
// explicitamente: getWhatsAppApiBaseUrl() tem um fallback antigo que manda
// determinados hostnames da Vercel para http://localhost:3001 — aqui isso é
// contornado, senão o atendimento nunca encontraria a VPS.
window.CRM_WHATSAPP_API_URL = CRM_IS_LOCAL ? "" : CRM_PROD_API_URL;
