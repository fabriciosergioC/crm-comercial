// ============================================================================
//  Configuração da API do CRM
// ============================================================================
//  Produção (INTERINO): frontend + API na MESMA ORIGEM da Vercel ("/api").
//
//  A arquitetura definitiva (frontend na Vercel + API/Baileys numa VPS em
//  https://api.crm-comercial.com/api) ainda NÃO está no ar: o domínio
//  api.crm-comercial.com não existe (DNS NXDOMAIN). Enquanto a VPS não sobe,
//  usamos a API serverless da Vercel para os DADOS (leads, auth, propostas...).
//  O WhatsApp via Baileys NÃO roda na Vercel — nessas rotas a API responde 503
//  até a VPS existir.
//
//    Local (localhost/file://) -> variáveis vazias; getApiBaseUrl() usa localhost:3001
//    Produção (Vercel)         -> "/api" (mesma origem)
//
//  Quando a VPS estiver pronta, troque CRM_PROD_API_URL para
//  "https://api.crm-comercial.com/api".
// ============================================================================
const CRM_PROD_API_URL = "/api";

const CRM_IS_LOCAL =
  typeof window !== "undefined" &&
  (window.location.protocol === "file:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "");

// Base da API (leads, auth, propostas, enriquecimento...)
window.CRM_API_URL = CRM_IS_LOCAL ? "" : CRM_PROD_API_URL;

// Base específica do WhatsApp. Em produção usa a mesma origem ("/api"),
// declarado explicitamente para NÃO cair no fallback antigo de
// getWhatsAppApiBaseUrl(), que manda o hostname da Vercel para
// http://localhost:3001 (conteúdo misto a partir de https — falha).
window.CRM_WHATSAPP_API_URL = CRM_IS_LOCAL ? "" : CRM_PROD_API_URL;
