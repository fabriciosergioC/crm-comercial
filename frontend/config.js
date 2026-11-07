// ============================================================================
//  Configuração da API do CRM
// ============================================================================
//  Arquitetura atual (Railway/Vercel/VPS):
//
//    - DADOS (leads, auth, propostas, enriquecimento...): API do Railway em
//      https://crm-comercial.up.railway.app/api.
//    - WHATSAPP/Baileys: mesmo backend persistente do Railway, pois exige um
//      processo Node conectado e armazenamento durável.
//    - WHATSAPP (Baileys): NÃO roda na Vercel (exige processo Node persistente
//      + disco durável). Roda no backend LOCAL em http://localhost:3001/api.
//
//  Por isso o frontend hospedado na Vercel chama diretamente o Railway:
//    window.CRM_API_URL          -> domínio Railway/api
//    window.CRM_WHATSAPP_API_URL -> domínio Railway/api
//
//  Localmente (localhost/file://), a configuração continua vazia e os helpers
//  usam http://localhost:3001/api.
// ============================================================================
const CRM_PROD_API_URL = "https://crm-comercial.up.railway.app/api";
const CRM_PROD_WHATSAPP_URL = "https://crm-comercial.up.railway.app/api";

const CRM_IS_LOCAL =
  typeof window !== "undefined" &&
  (window.location.protocol === "file:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "");

// Base da API de DADOS (leads, auth, propostas, enriquecimento...)
window.CRM_API_URL = CRM_IS_LOCAL ? "" : CRM_PROD_API_URL;

// Domínio do túnel que você abre com o ABRIR_PARA_A_EQUIPE.bat.
const CRM_IS_TUNEL =
  typeof window !== "undefined" &&
  /(^|\.)ngrok(-free)?\.(app|com|dev|io)$/i.test(String(window.location.hostname || ""));

// Base específica do WhatsApp (Baileys). Fora do notebook e do túnel, ela usa
// o backend persistente do Railway. Pelo ngrok, o domínio público já entrega
// tudo em /api; apontar para localhost dentro do navegador estaria errado, pois
// localhost seria o computador de quem abriu o link.
window.CRM_WHATSAPP_API_URL = CRM_IS_TUNEL
  ? CRM_PROD_API_URL
  : (CRM_IS_LOCAL ? "" : CRM_PROD_WHATSAPP_URL);
