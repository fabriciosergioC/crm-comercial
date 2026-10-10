#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const keys = [
  'PORT','CORS_ORIGIN','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY',
  'SERPER_API_KEY','GOOGLE_PLACES_API_KEY','FOLLOWUP_NOTIFY_PHONE',
  'FOLLOWUP_SCHEDULER_INTERVAL_MIN','FOLLOWUP_NOTIFY_ENABLED',
  'ELEVENLABS_API_KEY','ELEVENLABS_VOICE_ID','ELEVENLABS_MODEL_ID'
];
const fmt = (k) => {
  const v = process.env[k];
  if (v === undefined) return '  ❌ ' + k + ' -> AUSENTE';
  if (v === '') return '  ⚠️  ' + k + ' -> VAZIO (aguardando preenchimento)';
  const show = /KEY|TOKEN|SECRET/.test(k) ? ('***[' + v.length + ' chars]') : v;
  return '  ✅ ' + k + ' = ' + show;
};
console.log('=== Parse do backend/.env pelo dotenv ===\n');
keys.forEach(k => console.log(fmt(k)));
console.log('');

const numIntervalo = parseInt(process.env.FOLLOWUP_SCHEDULER_INTERVAL_MIN, 10);
const okNum = !isNaN(numIntervalo);
console.log('  ' + (okNum ? '✅' : '❌') + ' FOLLOWUP_SCHEDULER_INTERVAL_MIN parse numerico: ' + (okNum ? numIntervalo : 'FALHOU (resto de comentario inline?)'));

const boolEnabled = process.env.FOLLOWUP_NOTIFY_ENABLED;
const okBool = boolEnabled === 'true' || boolEnabled === 'false';
console.log('  ' + (okBool ? '✅' : '❌') + ' FOLLOWUP_NOTIFY_ENABLED valor puro: "' + boolEnabled + '"');

console.log('\n=== Resumo ElevenLabs ===');
const k = process.env.ELEVENLABS_API_KEY;
const v = process.env.ELEVENLABS_VOICE_ID;
if (k && v) {
  console.log('  ✅ Chaves ElevenLabs preenchidas (nao exibidas por seguranca)');
} else {
  const faltam = [];
  if (!k) faltam.push('ELEVENLABS_API_KEY');
  if (!v) faltam.push('ELEVENLABS_VOICE_ID');
  console.log('  ℹ️  Ainda sem config ElevenLabs. Falta preencher: ' + faltam.join(', '));
  console.log('     (isso NAO impede o CRM de rodar; so desativa o botao "gerar audio")');
}

console.log('\n=== Resumo Supabase ===');
const url = process.env.SUPABASE_URL;
const sk = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (url && sk && url.startsWith('https://') && sk.length > 20) {
  console.log('  ✅ URL e service_role presentes — formato valido.');
} else {
  console.log('  ❌ Supabase mal configurado.');
  if (!url) console.log('     - SUPABASE_URL ausente');
  else if (!url.startsWith('https://')) console.log('     - SUPABASE_URL nao comeca com https://');
  if (!sk) console.log('     - SUPABASE_SERVICE_ROLE_KEY ausente');
  else if (sk.length < 20) console.log('     - SUPABASE_SERVICE_ROLE_KEY muito curta (' + sk.length + ' chars)');
}
console.log('');
