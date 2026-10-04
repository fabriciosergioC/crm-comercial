// ============================================================================
//  Configuração da API do CRM
// ============================================================================
//  Arquitetura atual (INTERINA, sem VPS):
//
//    - DADOS (leads, auth, propostas, enriquecimento...): API serverless da
//      Vercel, na MESMA ORIGEM ("/api").
//    - WHATSAPP (Baileys): NÃO roda na Vercel (exige processo Node persistente
//      + disco durável). Roda no backend LOCAL em http://localhost:3001/api.
//
//  Por isso o frontend hospedado na Vercel chama:
//    window.CRM_API_URL          -> "/api"                     (dados, Vercel)
//    window.CRM_WHATSAPP_API_URL -> "http://localhost:3001/api" (WhatsApp, local)
//
//  O servidor local (porta 3001) precisa estar no ar com o Baileys CONNECTED.
//  O backend já libera CORS para *.vercel.app e envia
//  Access-Control-Allow-Private-Network: true no preflight (PNA), permitindo
//  que a página https da Vercel chame http://localhost:3001.
//
//    Local (localhost/file://) -> variáveis vazias; getApiBaseUrl()/
//                                 getWhatsAppApiBaseUrl() já usam localhost:3001
//    Produção (Vercel)         -> dados "/api" / WhatsApp localhost:3001
//
//  Quando a VPS estiver pronta, troque CRM_PROD_WHATSAPP_URL para
//  "https://api.crm-comercial.com/api".
// ============================================================================
const CRM_PROD_API_URL = "/api";
const CRM_PROD_WHATSAPP_URL = "http://localhost:3001/api";

const CRM_IS_LOCAL =
  typeof window !== "undefined" &&
  (window.location.protocol === "file:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "");

// Base da API de DADOS (leads, auth, propostas, enriquecimento...)
window.CRM_API_URL = CRM_IS_LOCAL ? "" : CRM_PROD_API_URL;

// Base específica do WhatsApp (Baileys). Em produção aponta para o backend
// LOCAL na porta 3001, pois o Baileys não roda na Vercel serverless.
window.CRM_WHATSAPP_API_URL = CRM_IS_LOCAL ? "" : CRM_PROD_WHATSAPP_URL;
