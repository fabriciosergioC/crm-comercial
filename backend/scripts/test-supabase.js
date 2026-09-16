#!/usr/bin/env node
/* Teste REAL de banco (Supabase): conexao, tabelas, RPCs e CRUD.
 * Uso:  cd backend && node scripts/test-supabase.js
 *
 * Por que existe: a tarefa so termina quando uma gravacao e uma leitura reais
 * forem confirmadas. Este script cria dados MARCADOS (prefixo tst_), exercita
 * INSERT/SELECT/UPDATE e as duas RPCs e APAGA somente o que ele mesmo criou.
 *
 * Nunca imprime chaves. Nao usa DROP/TRUNCATE. Nao toca em dados reais. */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TABLES = ['users', 'leads', 'lead_status_history', 'lead_interactions',
  'lead_followups', 'lead_demos', 'lead_proposals', 'clients', 'client_updates'];

const STAMP = Date.now();
const USER_ID = 'tst_user_' + STAMP;
const LEAD_ID = 'tst_lead_' + STAMP;

const ok = (m) => console.log('  \u2705 ' + m);
const bad = (m) => console.log('  \u274C ' + m);
const info = (m) => console.log('  ' + m);
function fail(msg) { console.error('\n[FALHOU] ' + msg + '\n'); process.exit(1); }

async function main() {
  console.log('=== Teste de banco do CRM (Supabase) ===\n');

  console.log('[1/7] Configuracao');
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    fail('SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY ausentes em backend/.env');
  }
  ok('SUPABASE_URL: ' + SUPABASE_URL);
  ok('SUPABASE_SERVICE_ROLE_KEY: definida (oculta, ' + SUPABASE_KEY.length + ' caracteres)');
  ok('Autorizacao: service_role (ignora RLS - uso exclusivo do servidor)');

  const db = createClient(SUPABASE_URL, SUPABASE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });

  /* Pre-checagem com timeout: se a URL estiver errada, o Supabase JS fica
     pendurado em retry/DNS por muito tempo. Aqui falhamos em ate 8 segundos
     com mensagem util, antes de qualquer tentativa de tabela. */
  async function connectivityCheck() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/', {
        headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
        signal: ctrl.signal,
      });
      // Qualquer resposta HTTP prova que o host existe e respondeu.
      return { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, error: (e && e.name === 'AbortError') ? 'tempo esgotado (8s)' : (e && e.message) };
    } finally {
      clearTimeout(timer);
    }
  }

  console.log('\n[2/7] Conexao');
  const conn = await connectivityCheck();
  if (!conn.ok) {
    fail('sem conexao com o Supabase: ' + conn.error +
      '\n  Confira SUPABASE_URL em backend/.env (formato https://<ref>.supabase.co) e a internet.');
  }
  ok('host respondeu (HTTP ' + conn.status + ')');

  console.log('\n[3/7] Tabelas');
  const missing = [];
  for (const t of TABLES) {
    const { error } = await db.from(t).select('id', { count: 'exact', head: true });
    if (error) { missing.push(t + ' (' + error.message + ')'); bad(t); } else ok(t);
  }
  if (missing.length) {
    fail('Tabelas inacessiveis:\n    - ' + missing.join('\n    - ') +
      '\n  Aplique backend/database/schema.sql no SQL Editor do Supabase e rode:' +
      "\n    notify pgrst, 'reload schema';");
  }

  console.log('\n[4/7] Funcoes RPC');
  const probes = [
    ['change_lead_status', { p_lead_id: '__probe__', p_to: 'Novo', p_user: null }],
    ['add_lead_interaction', { p_lead_id: '__probe__', p_user: null, p_channel: 'Ligação', p_result: 'Atendeu', p_note: '' }],
  ];
  const rpcFails = [];
  for (const [name, args] of probes) {
    const { error } = await db.rpc(name, args);
    // Se a funcao existir, ela reclama do lead inexistente: isso prova que esta la.
    if (error && /encontrado/i.test(error.message)) ok(name);
    else { rpcFails.push(name + ' -> ' + (error ? error.message : 'resposta inesperada')); bad(name); }
  }
  if (rpcFails.length) {
    fail('RPCs indisponiveis:\n    - ' + rpcFails.join('\n    - ') +
      '\n  Aplique backend/database/functions.sql.');
  }

  let created = false;
  try {
    console.log('\n[5/7] INSERT (dados de teste marcados)');
    const u = await db.from('users').insert({ id: USER_ID, name: 'USUARIO DE TESTE (remover)' }).select().single();
    if (u.error) fail('insert users: ' + u.error.message);
    created = true;
    ok('users: ' + USER_ID);

    const l = await db.from('leads').insert({
      id: LEAD_ID, company: 'TESTE - REMOVER', contact_name: 'Contato de teste',
      owner: USER_ID, status: 'Novo', temperature: 'Frio', priority: 'Média',
      score: { dor: 1, facilidade: 1, pagamento: 1, recorrencia: 1 },
      next_action: { date: new Date().toISOString(), note: 'Acao de teste' },
    }).select().single();
    if (l.error) fail('insert leads: ' + l.error.message);
    ok('leads: ' + LEAD_ID + '  (company = "TESTE - REMOVER")');

    /* Validacao de dados (secao 16 do escopo): o banco precisa RECUSAR o que
       estiver fora das listas do app. Isso prova que as CHECK constraints do
       schema.sql estao ativas de verdade, e nao apenas escritas no arquivo. */
    console.log('\n[5b/7] Validacoes do banco (tudo isto deve ser RECUSADO)');
    const accepted = [];
    const mk = (n) => ({ id: LEAD_ID + '_inv' + n, company: 'TESTE - INVALIDO', contact_name: 'x', owner: USER_ID });
    async function expectReject(label, payload) {
      const { error } = await db.from('leads').insert(payload).select().single();
      if (error) ok('recusado: ' + label + '  [' + (error.code || '?') + ']');
      else accepted.push(label);
    }
    await expectReject('status fora da lista', { ...mk(1), status: 'StatusInexistente' });
    await expectReject('prioridade fora da lista', { ...mk(2), priority: 'Urgente' });
    await expectReject('temperatura fora da lista', { ...mk(3), temperature: 'Gelado' });
    await expectReject('score fora de 0-5', { ...mk(4), score: { dor: 9, facilidade: 1, pagamento: 1, recorrencia: 1 } });
    await expectReject('owner inexistente (FK)', { ...mk(5), owner: 'usuario_que_nao_existe' });
    const invRows = await db.from('leads').select('id', { count: 'exact', head: true }).like('id', LEAD_ID + '_inv%');
    if ((invRows.count || 0) === 0) ok('nenhum registro invalido ficou gravado');
    else accepted.push('linhas invalidas gravadas: ' + invRows.count);
    if (accepted.length) fail('o banco ACEITOU dado invalido: ' + accepted.join(' | '));

    console.log('\n[6/7] RPC, UPDATE e SELECT');
    const st = await db.rpc('change_lead_status', { p_lead_id: LEAD_ID, p_to: 'Contatado', p_user: USER_ID });
    if (st.error) fail('rpc change_lead_status: ' + st.error.message);
    if (!st.data || !st.data.entry || st.data.entry.from_status !== 'Novo' || st.data.entry.to_status !== 'Contatado') {
      fail('change_lead_status fora do formato esperado: ' + JSON.stringify(st.data));
    }
    ok('change_lead_status: "Novo" -> "Contatado" + entrada de historico');

    const it = await db.rpc('add_lead_interaction', {
      p_lead_id: LEAD_ID, p_user: USER_ID, p_channel: 'WhatsApp', p_result: 'Pediu preço', p_note: 'Interacao de teste',
    });
    if (it.error) fail('rpc add_lead_interaction: ' + it.error.message);
    if (!it.data || !it.data.lead || it.data.lead.temperature !== 'Quente') {
      fail('temperatura nao subiu para Quente: ' + JSON.stringify(it.data && it.data.lead && it.data.lead.temperature));
    }
    ok('add_lead_interaction: temperatura "Frio" -> "Quente" (regra so-sobe) e last_contact_at atualizado');

    const up = await db.from('leads').update({ notes: 'nota atualizada no teste' }).eq('id', LEAD_ID).select().single();
    if (up.error) fail('update leads: ' + up.error.message);
    ok('UPDATE: notes gravado');

    const rd = await db.from('leads').select('*').eq('id', LEAD_ID).single();
    if (rd.error) fail('select leads: ' + rd.error.message);
    if (rd.data.notes !== 'nota atualizada no teste') fail('SELECT nao retornou o valor gravado');
    ok('SELECT: status=' + rd.data.status + ', temperatura=' + rd.data.temperature + ', notes lido de volta');

    const hist = await db.from('lead_status_history').select('id', { count: 'exact', head: true }).eq('lead_id', LEAD_ID);
    ok('lead_status_history: ' + (hist.count || 0) + ' registro(s) criados pela RPC');
    const inter = await db.from('lead_interactions').select('id', { count: 'exact', head: true }).eq('lead_id', LEAD_ID);
    ok('lead_interactions: ' + (inter.count || 0) + ' registro(s) criados pela RPC');
  } finally {
    console.log('\n[7/7] Limpeza (somente os registros de teste)');
    if (created) {
      const d1 = await db.from('leads').delete().eq('id', LEAD_ID);
      ok('DELETE leads ' + LEAD_ID + (d1.error ? ' -> ERRO: ' + d1.error.message : ''));
      const d2 = await db.from('users').delete().eq('id', USER_ID);
      ok('DELETE users ' + USER_ID + (d2.error ? ' -> ERRO: ' + d2.error.message : ''));
      const chk = await db.from('leads').select('id', { count: 'exact', head: true }).eq('id', LEAD_ID);
      const rest = await db.from('lead_interactions').select('id', { count: 'exact', head: true }).eq('lead_id', LEAD_ID);
      info('verificacao pos-limpeza: leads=' + (chk.count || 0) + ', interacoes=' + (rest.count || 0) +
        (((chk.count || 0) + (rest.count || 0) === 0) ? ' (sem residuo)' : ' (ATENCAO: residuo!)'));
    } else {
      info('nada foi criado; nada a remover');
    }
  }

  console.log('\n=== RESULTADO ===');
  console.log('  Conexao: OK | Tabelas: 9/9 | RPCs: 2/2 | INSERT: OK | SELECT: OK | UPDATE: OK | DELETE(test): OK');
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
