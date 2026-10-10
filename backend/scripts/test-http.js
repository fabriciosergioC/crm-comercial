#!/usr/bin/env node
'use strict';
const BASE = 'http://localhost:3001';
const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => console.log('  ❌ ' + m);

async function req(url, opt) {
  try {
    const r = await fetch(url, opt);
    const ct = r.headers.get('content-type') || '';
    let body;
    if (ct.includes('application/json')) body = await r.json();
    else body = await r.text();
    return { ok: r.ok, status: r.status, ct, body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

(async () => {
  console.log('=== Teste HTTP no servidor rodando em ' + BASE + ' ===\n');

  // Health
  console.log('[1/2] GET /api/health');
  const h = await req(BASE + '/api/health');
  if (h.ok && h.body && h.body.success) ok('HTTP ' + h.status + ' — success=true, message="' + (h.body.message || '') + '"');
  else bad('resposta inesperada: ' + (h.error || ('HTTP ' + h.status + ' ' + JSON.stringify(h.body))));

  // TTS preview (deve retornar 503 com mensagem amigavel, pois chaves nao foram preenchidas)
  console.log('\n[2/2] POST /api/whatsapp/tts/preview (body: {"text":"Olá CRM"})');
  const t = await req(BASE + '/api/whatsapp/tts/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Olá CRM, teste de integração.' })
  });

  if (t.error) { bad('falha de conexao: ' + t.error); }
  else if (t.status === 503 && t.body && t.body.success === false && t.body.message) {
    ok('HTTP 503 como esperado (chaves nao preenchidas). Mensagem: ' + t.body.message);
  } else if (t.status === 200 && t.ct.includes('audio/mpeg')) {
    ok('HTTP 200 e Content-Type audio/mpeg (chaves preenchidas, audio gerado com ' + (t.body && t.body.length ? t.body.length : '?') + ' bytes)');
  } else if (t.status === 401 || t.status === 403) {
    ok('HTTP ' + t.status + ' (chave ElevenLabs preenchida mas invalida — integracacao OK, so credencial)');
  } else {
    bad('resposta inesperada: HTTP ' + t.status + ' Content-Type=' + t.ct + ' body=' + JSON.stringify(t.body).slice(0, 160));
  }

  console.log('\n=== Fim do teste HTTP ===');
})();
