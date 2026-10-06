/* Entry do executável-ponte do WhatsApp (CRM Comercial).
   Empacotado com esbuild + @yao-pkg/pkg. Faz tudo até chegar no QR Code:
   1. Define ambiente (sessão gravável e estável, porta 3001).
   2. Sobe o backend (Express) em 3001.
   3. Conecta o WhatsApp (Baileys) e mostra o QR Code no console + salva PNG. */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

/* Sessão do WhatsApp em pasta gravável e estável (fora do snapshot do exe).
   Sob pkg, __dirname aponta para o snapshot (somente leitura) — use APPDATA. */
const APP_DIR = path.join(process.env.APPDATA || os.homedir(), 'crm-whatsapp-bridge');
const AUTH_DIR = path.join(APP_DIR, 'whatsapp-auth');
fs.mkdirSync(AUTH_DIR, { recursive: true });
process.env.WHATSAPP_AUTH_DIR = AUTH_DIR;

/* Porta fixa 3001 e bind local. */
process.env.PORT = process.env.PORT || '3001';
process.env.HOST = process.env.HOST || '0.0.0.0';
/* Garante que o provider Baileys real seja usado (não o mock/indisponível). */
process.env.WHATSAPP_PROVIDER = process.env.WHATSAPP_PROVIDER || 'baileys';
delete process.env.VERCEL;
/* Não dispara lembretes de follow-up nesta ponte (eles rodam no backend principal). */
process.env.FOLLOWUP_NOTIFY_ENABLED = 'false';

/* Credenciais do Supabase: injetadas no build (scripts/build-bridge.js) a partir de
   backend/.env via esbuild --define — nunca ficam no código-fonte commitado.
   Podem ser sobrescritas por variável de ambiente em tempo de execução. */
process.env.SUPABASE_URL = process.env.SUPABASE_URL ||
  (typeof __SUPABASE_URL__ !== 'undefined' ? __SUPABASE_URL__ : '');
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  (typeof __SUPABASE_SERVICE_ROLE__ !== 'undefined' ? __SUPABASE_SERVICE_ROLE__ : '');

const app = require('../backend/server');
const whatsappService = require('../backend/services/whatsapp/WhatsAppService');
const QRCode = require('qrcode');

const FRONTEND_URL = 'https://crm-comercial-kappa.vercel.app';

function banner() {
  console.log('');
  console.log('==========================================================');
  console.log('  PONTE DO WHATSAPP — CRM COMERCIAL');
  console.log('==========================================================');
  console.log(`  Backend local:  http://127.0.0.1:${process.env.PORT}/api`);
  console.log(`  Sessão salva:   ${AUTH_DIR}`);
  console.log('');
  console.log(`  Abra o app no navegador:  ${FRONTEND_URL}`);
  console.log('  O app conecta neste backend local (porta 3001).');
  console.log('');
  console.log('  Quando o QR Code aparecer abaixo, escaneie com o WhatsApp');
  console.log('  do celular (Dispositivos conectados > Conectar dispositivo).');
  console.log('==========================================================');
  console.log('');
}

let lastQr = null;
let pngSavedFor = null;

async function saveQrPng(dataUrl) {
  if (!dataUrl || pngSavedFor === dataUrl) return;
  pngSavedFor = dataUrl;
  try {
    const base64 = dataUrl.split(',')[1];
    const pngPath = path.join(APP_DIR, 'whatsapp-qr.png');
    fs.writeFileSync(pngPath, Buffer.from(base64, 'base64'));
    console.log(`  QR salvo em: ${pngPath}`);
  } catch (e) { /* ignore */ }
}

async function showQr(qrCode, dataUrl) {
  lastQr = qrCode;
  try {
    const term = await QRCode.toString(qrCode, { type: 'terminal', small: true });
    console.log('');
    console.log('  >>> QR CODE DO WHATSAPP (escaneie agora) <<<');
    console.log(term);
  } catch (e) {
    console.warn('  Não foi possível desenhar o QR no console:', e.message);
  }
  await saveQrPng(dataUrl);
}

async function pollQr() {
  for (;;) {
    try {
      const status = whatsappService.getStatus();
      const provider = whatsappService.provider;
      const qrCode = provider && provider.qrCode;
      if (status && status.status === 'QR_READY' && status.qrAvailable && qrCode && qrCode !== lastQr) {
        await showQr(qrCode, status.qrImage);
      } else if (status && status.status === 'QR_READY' && status.qrAvailable) {
        await saveQrPng(status.qrImage);
      } else if (status && status.status === 'CONNECTED') {
        if (lastQr !== '__connected__') {
          lastQr = '__connected__';
          console.log('');
          console.log('  >>> WHATSAPP CONECTADO! Pode fechar/escanear. <<<');
          console.log('  Os lembretes de follow-up continuarão chegando.');
          console.log('');
        }
      }
    } catch (e) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 800));
  }
}

app.listen(Number(process.env.PORT), process.env.HOST, () => {
  banner();
  whatsappService
    .connect({ phoneNumber: process.env.WHATSAPP_PAIRING_PHONE || '' })
    .then((status) => console.log(`[whatsapp] Status após conexão: ${status && status.status}.`))
    .catch((error) => console.warn(`[whatsapp] Conexão falhou: ${error.message || error}`));
  pollQr();
});
