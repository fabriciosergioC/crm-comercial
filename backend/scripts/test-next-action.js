#!/usr/bin/env node
/* Teste unitario sem banco: node backend/scripts/test-next-action.js */
'use strict';

const assert = require('node:assert/strict');
const { nextAction } = require('../middleware/validate');
const { toRow } = require('../services/leadsService');

const date = '2026-09-19T10:00:00.000Z';

assert.equal(nextAction({}), undefined, 'campo omitido deve preservar o valor no PATCH');
assert.equal(nextAction({ nextAction: null }), null, 'null explicito deve limpar o valor no PATCH');
assert.deepEqual(
  nextAction({ nextAction: { date, note: 'Retornar com o cliente' } }),
  { date, note: 'Retornar com o cliente' },
  'objeto valido deve ser normalizado'
);
assert.deepEqual(
  nextAction({ nextAction: { note: 'Aguardar retorno' } }),
  { date: null, note: 'Aguardar retorno' },
  'observacao sem data deve manter a acao com data nula'
);
assert.equal(
  nextAction({ nextAction: { date: '', note: '' } }),
  null,
  'campos em branco devem limpar a proxima acao'
);
assert.throws(
  () => nextAction({ nextAction: [] }),
  /deve ser um objeto/,
  'arrays devem ser recusados'
);
assert.deepEqual(toRow({ nextAction: null }), { next_action: null }, 'null deve chegar ao mapper do banco');

console.log('OK: proxima acao omitida, nula e preenchida.');
