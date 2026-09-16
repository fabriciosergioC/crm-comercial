#!/usr/bin/env node
/* Teste REAL da API do CRM: HTTP -> Express -> services -> Supabase.
 *
 * Uso:  cd backend && node scripts/test-api.js
 *
 * O script sobe o servidor sozinho, exercita todos os recursos, confirma que
 * as validações RECUSAM dados inválidos e, no fim, apaga SOMENTE os registros
 * de teste (prefixo tst_). Nunca imprime credenciais.
 *
 * O acesso direto ao banco aqui serve apenas para preparar (usuário de teste)
 * e limpar os dados de teste — a API não expõe DELETE de propósito. */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const PORT = Number(process.env.PORT) || 3001;
const BASE = 'http://localhost:' + PORT + '/api';
const T = Date.now();
const USER_ID = 'tst_user_' + T;
const LEAD_ID = 'tst_lead_' + T;

let pass = 0;
let fail = 0;
const ok = (label, extra) => { pass++; console.log('  \u2705 ' + label + (extra ? '  -> ' + extra : '')); };
const bad = (label, extra) => { fail++; console.log('  \u274C ' + label + (extra ? '  -> ' + extra : '')); };
const check = (label, cond, extra) => (cond ? ok(label, extra) : bad(label, extra));

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* resposta sem corpo */ }
  return { status: res.status, body: json };
}

async function waitForServer(tentativas = 60) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.status === 200) return true;
    } catch (e) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  console.log('=== Teste da API do CRM ===\n');

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });

  /* Servidor: sobe em um processo filho para o teste ser auto-contido. */
  const erros = [];
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => erros.push(String(d)));

  try {
    console.log('[1/8] Subindo o servidor e checando /health');
    if (!(await waitForServer())) {
      throw new Error('O servidor nao respondeu em ' + BASE + '/health' + (erros.length ? '\n' + erros.join('') : ''));
    }
    const health = await req('GET', '/health');
    check('GET /api/health = 200', health.status === 200, health.body && health.body.status);

    console.log('\n[2/8] Preparando usuario de teste (direto no banco)');
    const u = await db.from('users').insert({ id: USER_ID, name: 'USUARIO DE TESTE (remover)' }).select().single();
    if (u.error) throw new Error('falha ao criar usuario de teste: ' + u.error.message);
    ok('usuario de teste criado', USER_ID);

    console.log('\n[3/8] Ciclo de vida do lead pela API');
    const created = await req('POST', '/leads', {
      id: LEAD_ID, company: 'TESTE - REMOVER', contactName: 'Contato de teste',
      owner: USER_ID, status: 'Novo', temperature: 'Frio', priority: 'Média',
      city: 'Coronel Fabriciano', segment: 'Alimentação', source: 'Indicação',
      score: { dor: 2, facilidade: 3, pagamento: 2, recorrencia: 1 },
      nextAction: { date: new Date().toISOString(), note: 'Acao de teste' },
    });
    check('POST /api/leads = 201', created.status === 201, 'HTTP ' + created.status);
    check('lead retornado com o id enviado', created.body && created.body.data && created.body.data.id === LEAD_ID);

    const list = await req('GET', '/leads');
    check('GET /api/leads contem o lead criado', list.status === 200 && list.body.data.some((l) => l.id === LEAD_ID), 'total ' + (list.body && list.body.count));

    const one = await req('GET', '/leads/' + LEAD_ID);
    check('GET /api/leads/:id = 200', one.status === 200 && one.body.data.id === LEAD_ID);

    const patched = await req('PATCH', '/leads/' + LEAD_ID, {
      notes: 'nota atualizada pela API', priority: 'Alta',
      score: { dor: 5, facilidade: 4, pagamento: 5, recorrencia: 4 },
    });
    check('PATCH /api/leads/:id aplicou notes e score',
      patched.status === 200 && patched.body.data.notes === 'nota atualizada pela API' && patched.body.data.score.dor === 5);

    const status = await req('POST', '/leads/' + LEAD_ID + '/status', { status: 'Contatado', user: USER_ID });
    check('POST /api/leads/:id/status gravou historico (Novo -> Contatado)',
      status.status === 200 && status.body.data.entry.from === 'Novo' && status.body.data.entry.to === 'Contatado');

    const inter = await req('POST', '/leads/' + LEAD_ID + '/interactions', {
      channel: 'WhatsApp', result: 'Pediu preço', note: 'Interacao via API', user: USER_ID,
    });
    check('POST /api/leads/:id/interactions subiu a temperatura (Frio -> Quente)',
      inter.status === 201 && inter.body.data.lead.temperature === 'Quente');

    const hist = await req('GET', '/status-history?leadId=' + LEAD_ID);
    check('GET /api/status-history?leadId= retornou 1 registro', hist.status === 200 && hist.body.count === 1);

    const inters = await req('GET', '/interactions?leadId=' + LEAD_ID);
    check('GET /api/interactions?leadId= retornou 1 registro', inters.status === 200 && inters.body.count === 1);
    console.log('\n[4/8] Follow-ups (concluir / reagendar / cancelar)');
    const f = await req('POST', '/followups', {
      leadId: LEAD_ID, dueDate: new Date(Date.now() + 3600000).toISOString(),
      note: 'Ligar de volta', createdBy: USER_ID,
    });
    check('POST /api/followups = 201', f.status === 201, 'HTTP ' + f.status);
    const fId = f.body && f.body.data && f.body.data.id;
    const fDone = await req('PATCH', '/followups/' + fId, { status: 'concluido' });
    check('PATCH /api/followups/:id -> concluido', fDone.status === 200 && fDone.body.data.status === 'concluido');
    const fCancel = await req('PATCH', '/followups/' + fId, { status: 'cancelado' });
    check('PATCH /api/followups/:id -> cancelado (valor novo do enums)', fCancel.status === 200 && fCancel.body.data.status === 'cancelado');
    const fList = await req('GET', '/followups?leadId=' + LEAD_ID);
    check('GET /api/followups?leadId= = 200', fList.status === 200 && fList.body.count === 1);

    console.log('\n[5/8] Demos (enviar / desativar)');
    const d = await req('POST', '/demos', {
      leadId: LEAD_ID, url: 'https://demo.exemplo.com/teste', validityHours: 24,
      owner: USER_ID, sentAt: new Date().toISOString(),
    });
    check('POST /api/demos = 201', d.status === 201, 'HTTP ' + d.status);
    const dId = d.body && d.body.data && d.body.data.id;
    const expires = d.body && d.body.data && d.body.data.expiresAt;
    check('expiresAt calculado pelo prazo de validade (24h)',
      !!expires && (new Date(expires) - new Date(d.body.data.sentAt)) === 24 * 3600000);
    const dOff = await req('PATCH', '/demos/' + dId, { deactivated: true });
    check('PATCH /api/demos/:id -> desativada', dOff.status === 200 && dOff.body.data.deactivated === true);

    console.log('\n[6/8] Propostas e clientes');
    const p = await req('POST', '/proposals', {
      leadId: LEAD_ID, plan: 'Site institucional', implementationValue: 2500,
      monthlyValue: 90, notes: 'Proposta de teste',
    });
    check('POST /api/proposals = 201', p.status === 201, 'HTTP ' + p.status);
    const pId = p.body && p.body.data && p.body.data.id;
    check('proposta nasce com status Enviada', p.body && p.body.data.status === 'Enviada');
    const pOk = await req('PATCH', '/proposals/' + pId, { status: 'Aprovada' });
    check('PATCH /api/proposals/:id -> Aprovada', pOk.status === 200 && pOk.body.data.status === 'Aprovada');
    const pList = await req('GET', '/proposals?leadId=' + LEAD_ID);
    check('GET /api/proposals?leadId= = 200', pList.status === 200 && pList.body.count === 1);

    const c = await req('POST', '/clients', {
      leadId: LEAD_ID, company: 'TESTE - REMOVER', contactName: 'Contato de teste',
      plan: 'Site institucional', contractedValue: 2500, monthlyValue: 90, owner: USER_ID,
    });
    check('POST /api/clients (conversao) = 201', c.status === 201, 'HTTP ' + c.status);
    const cId = c.body && c.body.data && c.body.data.id;
    const cDup = await req('POST', '/clients', {
      leadId: LEAD_ID, company: 'TESTE - REMOVER', contactName: 'x',
      plan: 'Landing page', contractedValue: 1, monthlyValue: 0,
    });
    check('segundo cliente para o MESMO lead e recusado (relacao 1:1)',
      cDup.status === 409 || cDup.status === 400, 'HTTP ' + cDup.status);

    const cu = await req('POST', '/client-updates', { clientId: cId, type: 'Alteração', note: 'Trocou fotos' });
    check('POST /api/client-updates = 201', cu.status === 201, 'HTTP ' + cu.status);
    const cuList = await req('GET', '/client-updates?clientId=' + cId);
    check('GET /api/client-updates?clientId= = 200', cuList.status === 200 && cuList.body.count === 1);
    console.log('\n[7/8] Validacoes (tudo isto deve ser RECUSADO)');
    const v1 = await req('POST', '/leads', { company: 'x', contactName: 'y', owner: USER_ID, campoInventado: 1 });
    check('campo desconhecido -> 400', v1.status === 400, 'HTTP ' + v1.status);
    const v2 = await req('POST', '/followups', { leadId: LEAD_ID, status: 'xpto' });
    check('status de follow-up invalido -> 400', v2.status === 400, 'HTTP ' + v2.status);
    const v3 = await req('POST', '/proposals', { leadId: LEAD_ID, plan: 'Plano inexistente' });
    check('plano fora das opcoes -> 400', v3.status === 400, 'HTTP ' + v3.status);
    const v4 = await req('PATCH', '/leads/' + LEAD_ID, {});
    check('PATCH sem campos -> 400', v4.status === 400, 'HTTP ' + v4.status);
    const v5 = await req('POST', '/leads', { company: 'x', contactName: 'y', owner: USER_ID, score: { dor: 9 } });
    check('score fora de 0-5 -> 400', v5.status === 400, 'HTTP ' + v5.status);
    const v6 = await req('GET', '/leads/nao_existe_xyz');
    check('lead inexistente -> 404', v6.status === 404, 'HTTP ' + v6.status);
    const v7 = await req('POST', '/leads/' + LEAD_ID + '/status', { status: 'StatusInexistente' });
    check('status de lead invalido -> 400', v7.status === 400, 'HTTP ' + v7.status);
    const v8 = await req('POST', '/leads', { contactName: 'sem empresa', owner: USER_ID });
    check('campo obrigatorio ausente -> 400', v8.status === 400, 'HTTP ' + v8.status);
  } finally {
    console.log('\n[8/8] Limpeza (somente os registros de teste)');
    try {
      /* A API não expõe DELETE de propósito; aqui a limpeza usa acesso direto
         ao banco apenas para remover os tst_*. A cascata leva historico,
         interacoes, follow-ups, demos, propostas, cliente e atualizacoes. */
      await db.from('leads').delete().eq('id', LEAD_ID);
      await db.from('users').delete().eq('id', USER_ID);

      const checagens = [
        ['leads', 'id', LEAD_ID],
        ['lead_status_history', 'lead_id', LEAD_ID],
        ['lead_interactions', 'lead_id', LEAD_ID],
        ['lead_followups', 'lead_id', LEAD_ID],
        ['lead_demos', 'lead_id', LEAD_ID],
        ['lead_proposals', 'lead_id', LEAD_ID],
        ['clients', 'lead_id', LEAD_ID],
        ['users', 'id', USER_ID],
      ];
      const restos = {};
      for (const [t, col, val] of checagens) {
        const r = await db.from(t).select('id', { count: 'exact', head: true }).eq(col, val);
        restos[t] = r.count || 0;
      }
      const total = Object.values(restos).reduce((a, b) => a + b, 0);
      check('nenhum residuo de teste no banco', total === 0, JSON.stringify(restos));
    } catch (e) {
      bad('limpeza falhou: ' + e.message);
    } finally {
      server.kill();
    }
  }

  console.log('\n=== RESULTADO DA API ===');
  console.log('  Passou: ' + pass + ' | Falhou: ' + fail);
  console.log('  Recursos: leads, status-history, interactions, followups, demos, proposals, clients, client-updates');
  if (fail > 0) {
    console.error('\n[FALHOU] ' + fail + ' verificacao(oes) nao passaram.\n');
    process.exit(1);
  }
  console.log('\n[OK] API validada de ponta a ponta contra o banco real.\n');
}

main().catch((e) => {
  console.error('\n[FALHOU] ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
});

