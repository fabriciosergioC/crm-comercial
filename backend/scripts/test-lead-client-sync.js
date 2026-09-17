#!/usr/bin/env node
/* Teste local sem credenciais: node backend/scripts/test-lead-client-sync.js */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

const tables = {
  leads: [
    { id: 'l1', company: 'Empresa antiga', contact_name: 'Contato antigo', owner: 'u1', status: 'Fechado' },
    { id: 'l2', company: 'Sem cliente', contact_name: 'Contato', owner: 'u1' },
  ],
  clients: [
    { id: 'c1', lead_id: 'l1', company: 'Empresa antiga', contact_name: 'Contato antigo', owner: 'u1',
      plan: 'Landing page', contracted_value: 700, monthly_value: 89, domain: 'exemplo.com.br',
      notes: 'Notas do contrato', status: 'Ativo', closing_date: '2026-09-15T00:00:00Z' },
    { id: 'c2', lead_id: null, company: 'Independente', contact_name: 'Outro', owner: 'u2' },
  ],
};
let failClientUpdate = false;
let clientWrites = 0;
const supabase = {
  from(table) {
    const filters = [];
    let patch;
    let single = false;
    const q = {
      select() { return q; },
      order() { return q; },
      limit() { return q; },
      eq(key, value) { filters.push([key, value]); return q; },
      update(value) { patch = value; return q; },
      single() { single = true; return q; },
      maybeSingle() { single = true; return q; },
      then(resolve, reject) {
        const rows = tables[table].filter(row => filters.every(([k, v]) => row[k] === v));
        if (patch && table === 'clients') {
          clientWrites++;
          if (failClientUpdate) return Promise.resolve({ error: { message: 'Falha simulada' } }).then(resolve, reject);
        }
        if (patch) rows.forEach(row => Object.assign(row, patch));
        return Promise.resolve({ data: structuredClone(single ? rows[0] || null : rows), error: null }).then(resolve, reject);
      },
    };
    return q;
  },
};
const configPath = require.resolve('../config/supabase');
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true,
  exports: { supabase, isConfigured: true } };

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const start = html.indexOf('function syncClientsWithLeads(');
const end = html.indexOf('const TONE_STYLE', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({});
vm.runInContext(html.slice(start, end), context);
const reduce = context.dbReducer;
const json = value => JSON.parse(JSON.stringify(value));

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api/leads', require('../routes/leadsRoutes'));
  app.use('/api/clients', require('../routes/clientsRoutes'));
  app.use(require('../middleware/errorHandler').errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (url, patch) => {
    const res = await fetch(base + url, patch ? {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    } : undefined);
    return { status: res.status, body: await res.json() };
  };
  try {
    const load = async () => ({ leads: (await request('/leads')).body.data, clients: (await request('/clients')).body.data });
    const before = await load();
    const patch = { company: 'Empresa nova', contactName: 'Contato novo', owner: 'u2', notes: 'Notas do lead', currentSite: 'outro.com.br' };
    const optimistic = reduce(before, { type: 'UPDATE_LEAD', id: 'l1', patch });
    assert.equal(optimistic.clients[0].company, patch.company);
    assert.equal(optimistic.clients[0].owner, patch.owner);
    assert.equal(before.clients[0].company, 'Empresa antiga');
    const saved = await request('/leads/l1', patch);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.success, true);
    const after = await load();
    const expected = { ...before.clients[0], company: patch.company, contactName: patch.contactName, owner: patch.owner };
    assert.deepEqual(after.clients[0], expected, 'Persistência preserva contrato');
    assert.deepEqual(json(optimistic.clients[0]), expected, 'Interface e API consistentes');
    assert.deepEqual(after.clients[1], before.clients[1], 'Cliente independente preservado');
    const reloaded = reduce(before, { type: 'SET_DB', db: after });
    assert.deepEqual(json(reloaded.clients), after.clients, 'Recarga mantém atualização');
    const stale = reduce(before, { type: 'SET_DB', db: { leads: after.leads } });
    assert.deepEqual(json(stale.clients[0]), expected, 'Dados antigos reconciliados');
    assert.equal((await request('/leads/l2', { company: 'Sem vínculo atualizado' })).status, 200);
    assert.equal(tables.clients.length, 2, 'Não cria cliente automaticamente');
    const writes = clientWrites;
    assert.equal((await request('/leads/l1', { temperature: 'Quente' })).status, 200);
    assert.equal(clientWrites, writes, 'Campos exclusivos não gravam no cliente');
    assert.equal((await request('/leads/inexistente', { company: 'Teste' })).status, 404);
    failClientUpdate = true;
    const failure = await request('/leads/l1', { company: 'Nova tentativa' });
    assert.equal(failure.status, 502);
    assert.match(failure.body.message, /Lead salvo.*cliente vinculado/);
    failClientUpdate = false;
    assert.equal((await request('/leads/l1', { company: 'Nova tentativa' })).status, 200);
    assert.equal((await load()).clients[0].company, 'Nova tentativa');
    console.log('OK: edição, persistência, recarga, dados antigos, contrato, ausência de vínculo e falhas.');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
