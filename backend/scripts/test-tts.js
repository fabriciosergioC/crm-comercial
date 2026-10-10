#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { generateSpeech, listVoiceProfiles, MAX_TEXT_LENGTH, MAX_AUDIO_BYTES } = require("../services/ttsService");

console.log('=== Teste do servico TTS (ElevenLabs) ===\n');

const t = (label, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(v => ({ threw: false, value: v })).catch(e => ({ threw: true, error: e }));
    }
    return Promise.resolve({ threw: false, value: r });
  } catch (e) {
    return Promise.resolve({ threw: true, error: e });
  }
};

const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => console.log('  ❌ ' + m);

(async () => {
  // Teste 1: constantes do modulo
  console.log('[1/5] Constantes exportadas');
  if (MAX_TEXT_LENGTH === 3000 && MAX_AUDIO_BYTES === 8 * 1024 * 1024) {
    ok('MAX_TEXT_LENGTH=' + MAX_TEXT_LENGTH + ', MAX_AUDIO_BYTES=' + MAX_AUDIO_BYTES);
  } else {
    bad('Constantes divergentes');
  }

  // Teste 2: texto vazio -> 400
  console.log('\n[2/5] Validacao entrada: texto vazio');
  const r1 = await t('vazio', () => generateSpeech(''));
  if (r1.threw && r1.error && r1.error.status === 400) ok('retornou erro 400: "' + r1.error.message.split('.')[0] + '."');
  else bad('esperava 400, obteve: ' + (r1.threw ? (r1.error && r1.error.status + ' ' + r1.error.message) : 'sucesso inesperado'));

  // Teste 3: texto longo -> 400
  console.log('\n[3/5] Validacao entrada: texto > limite');
  const r2 = await t('longo', () => generateSpeech('x'.repeat(MAX_TEXT_LENGTH + 1)));
  if (r2.threw && r2.error && r2.error.status === 400) ok('retornou erro 400 (texto excede limite)');
  else bad('esperava 400, obteve: ' + (r2.threw ? (r2.error && r2.error.status + ' ' + r2.error.message) : 'sucesso inesperado'));

  // Teste 4: erros de perfil/texto barrados antes de gastar crédito
  console.log('\n[4/5] Perfis de voz e texto com placeholder (sem chamar a API)');
  const perfis = listVoiceProfiles();
  const defaultCount = perfis.filter(p => p.isDefault).length;
  if (perfis.length >= 2 && defaultCount === 1 && perfis.every(p => p.key && p.label && p.modelId)) {
    ok('perfis: ' + perfis.map(p => p.key + ' -> ' + p.modelId + (p.isDefault ? ' (padrao)' : '')).join(', '));
  } else {
    bad('listVoiceProfiles devolveu algo inesperado: ' + JSON.stringify(perfis));
  }
  const rP = await t('perfil-inexistente', () => generateSpeech('Oi.', 'voz-de-roboto'));
  if (rP.threw && rP.error && rP.error.status === 400) ok('perfil inexistente barrado com 400');
  else bad('esperava 400 para perfil inexistente, obteve: ' + (rP.threw ? rP.error.status : 'sucesso'));
  const rN = await t('placeholder', () => generateSpeech('Fala, [NOME], tudo bem?', 'natural'));
  if (rN.threw && rN.error && rN.error.status === 400 && /preencher/.test(rN.error.message)) ok('[NOME] sem preencher vira erro claro: "' + rN.error.message + '"');
  else bad('esperava 400 de placeholder, obteve: ' + (rN.threw ? rN.error.status + ' ' + rN.error.message : 'sucesso'));
  const rT = await t('so-tags', () => generateSpeech('[pause] [excited]', 'natural'));
  if (rT.threw && rT.error && rT.error.status === 400) ok('texto apenas com marcacoes barrado com 400');
  else bad('esperava 400 para texto só com tags, obteve: ' + (rT.threw ? rT.error.status : 'sucesso'));

  // Teste 5: chaves vazias -> 503
  console.log('\n[5/5] Validacao configuracao: chaves ElevenLabs ausentes');
  const r3 = await t('sem-chaves', () => generateSpeech('Olá, teste do CRM!'));
  const semChave = !process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID;
  if (semChave) {
    if (r3.threw && r3.error && r3.error.status === 503) ok('retornou 503 com mensagem amigavel (como esperado sem preencher chaves)');
    else bad('esperava 503, obteve: ' + (r3.threw ? (r3.error && r3.error.status + ' ' + r3.error.message) : 'sucesso inesperado'));
  } else {
    if (!r3.threw && Buffer.isBuffer(r3.value) && r3.value.length > 0) ok('gerou audio MP3 de ' + r3.value.length + ' bytes (chaves preenchidas e validas!)');
    else bad('chaves presentes mas geracao falhou: ' + (r3.threw ? (r3.error && r3.error.status + ' ' + r3.error.message) : 'buffer vazio'));
  }

  console.log('\n=== Fim do teste TTS ===');
})();
