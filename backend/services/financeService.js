const { supabase, isConfigured } = require('../config/supabase');
const { ApiError } = require('../middleware/errorHandler');
const { buildMapper, parseFilters, parseLimit, mapDbError, newId } = require('./modelHelpers');

/* ===========================================================================
   Financeiro (vendas avulsas, recebimentos e comissão) — migration 014.

   O que NÃO mora aqui de propósito: a venda que nasce de um Cliente fechado.
   Ela já existe na tabela clients (contracted_value + monthly_value + owner +
   closing_date), então a tela Financeiro lê clients e junta com as vendas
   avulsas desta tabela. Copiar para cá criaria dois números para conferir e a
   conta errada ia depender de qual dos dois foi atualizado por último.

   SEM delete, como o resto do projeto: lançamento errado vira status
   ('Cancelada' / 'Cancelado') e sai das somas, mas a linha fica.
   =========================================================================== */

const SALE_COLUMNS = {
  id: 'id',
  company: 'company',
  description: 'description',
  value: 'value',
  kind: 'kind',
  saleDate: 'sale_date',
  owner: 'owner',
  status: 'status',
  notes: 'notes',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PAYMENT_COLUMNS = {
  id: 'id',
  clientId: 'client_id',
  saleId: 'sale_id',
  company: 'company',
  description: 'description',
  amount: 'amount',
  kind: 'kind',
  dueDate: 'due_date',
  period: 'period',
  paidAt: 'paid_at',
  method: 'method',
  status: 'status',
  notes: 'notes',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const SETTINGS_COLUMNS = {
  id: 'id',
  commissionPercent: 'commission_percent',
  updatedAt: 'updated_at',
};

const saleMap = buildMapper(SALE_COLUMNS);
const paymentMap = buildMapper(PAYMENT_COLUMNS);
const settingsMap = buildMapper(SETTINGS_COLUMNS);

const SALE_FILTERS = ['owner', 'status', 'kind'];
const PAYMENT_FILTERS = ['clientId', 'saleId', 'status', 'kind', 'period'];

const TABLES_MISSING =
  'As tabelas do Financeiro não existem no Supabase ainda. Cole o conteúdo de ' +
  'backend/database/migrations/014_financeiro.sql no SQL Editor e reinicie o run-crm.bat.';

function assertReady() {
  if (!isConfigured || !supabase) {
    throw new ApiError(503, 'Supabase não configurado — defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do backend.');
  }
}

/* Sem as tabelas, o erro do PostgREST é opaco (PGRST205). Aqui ele vira a frase
   que diz o que colar e onde, porque é isso que ele precisa fazer uma vez só. */
function dbError(error, fallback) {
  if (error && (error.code === 'PGRST205' || error.code === '42P01')) {
    return new ApiError(503, TABLES_MISSING);
  }
  return mapDbError(error, fallback);
}

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

/* 'YYYY-MM-01' do primeiro dia do mês. Aceita o que a tela manda ('2026-10',
   '2026-10-05' ou ISO com hora) e devolve sempre a mesma forma, senão o índice
   único de (client_id, period) deixaria de pegar o lançamento duplicado. */
function normalizePeriod(value) {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-01`;
  }
  const raw = String(value || '').trim();
  if (!raw) return normalizePeriod(new Date());
  const direto = /^(\d{4})-(\d{2})(?:-\d{2})?/.exec(raw);
  if (direto) return `${direto[1]}-${direto[2]}-01`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, 'Período inválido — use o ano e o mês, por exemplo 2026-10.');
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function monthLabel(period) {
  const m = /^(\d{4})-(\d{2})/.exec(String(period || ''));
  if (!m) return '';
  return `${MESES[Number(m[2]) - 1]}/${m[1]}`;
}

/* ------------------------------ vendas avulsas ---------------------------- */

async function listSales(query) {
  assertReady();
  let q = supabase.from('finance_sales').select('*')
    .order('sale_date', { ascending: false, nullsFirst: false })
    .limit(parseLimit(query));
  for (const [column, value] of parseFilters(query, SALE_COLUMNS, SALE_FILTERS)) q = q.eq(column, value);
  const { data, error } = await q;
  if (error) throw dbError(error, 'Falha ao consultar as vendas avulsas.');
  return (data || []).map(saleMap.fromRow);
}

async function getSale(id) {
  assertReady();
  const { data, error } = await supabase.from('finance_sales').select('*').eq('id', id).maybeSingle();
  if (error) throw dbError(error, 'Falha ao consultar a venda.');
  if (!data) throw new ApiError(404, 'Venda avulsa não encontrada.');
  return saleMap.fromRow(data);
}

async function createSale(payload) {
  assertReady();
  const row = saleMap.toRow(payload);
  if (!row.id) row.id = newId('fs');
  if (!row.status) row.status = 'Ativa';
  if (!row.kind) row.kind = 'Serviço avulso';
  if (!row.sale_date) row.sale_date = new Date().toISOString();
  const { data, error } = await supabase.from('finance_sales').insert(row).select().single();
  if (error) throw dbError(error, 'Falha ao lançar a venda avulsa.');
  return saleMap.fromRow(data);
}

async function updateSale(id, patch) {
  assertReady();
  await getSale(id);
  const row = saleMap.toRow(patch);
  delete row.id;
  if (Object.keys(row).length === 0) return getSale(id);
  const { data, error } = await supabase.from('finance_sales').update(row).eq('id', id).select().single();
  if (error) throw dbError(error, 'Falha ao atualizar a venda avulsa.');
  return saleMap.fromRow(data);
}

/* ------------------------------- recebimentos ----------------------------- */

async function listPayments(query) {
  assertReady();
  let q = supabase.from('finance_payments').select('*')
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(parseLimit(query));
  for (const [column, value] of parseFilters(query, PAYMENT_COLUMNS, PAYMENT_FILTERS)) {
    q = column === 'period' ? q.eq('period', normalizePeriod(value)) : q.eq(column, value);
  }
  const { data, error } = await q;
  if (error) throw dbError(error, 'Falha ao consultar os recebimentos.');
  return (data || []).map(paymentMap.fromRow);
}

async function getPayment(id) {
  assertReady();
  const { data, error } = await supabase.from('finance_payments').select('*').eq('id', id).maybeSingle();
  if (error) throw dbError(error, 'Falha ao consultar o recebimento.');
  if (!data) throw new ApiError(404, 'Recebimento não encontrado.');
  return paymentMap.fromRow(data);
}

/* Todo recebimento aponta para um cliente OU para uma venda avulsa. Conferir o
   destino aqui (e não só o CHECK do banco) é o que devolve "esse registro não
   existe" em vez de 400 de FK genérica no meio da tela. */
async function assertTarget({ clientId, saleId }) {
  assertReady();
  if (clientId && saleId) throw new ApiError(400, 'O recebimento aponta para um cliente e para uma venda ao mesmo tempo.');
  if (!clientId && !saleId) throw new ApiError(400, 'Escolha o cliente ou a venda avulsa deste recebimento.');
  if (clientId) {
    const { data, error } = await supabase.from('clients').select('id, company').eq('id', clientId).maybeSingle();
    if (error) throw dbError(error, 'Falha ao consultar o cliente.');
    if (!data) throw new ApiError(404, 'Cliente não encontrado — o recebimento não foi gravado.');
    return data;
  }
  const sale = await getSale(saleId);
  return { id: sale.id, company: sale.company };
}

/* Uma implantação se cobra uma vez por mês. O índice único do banco só trava a
   mensalidade (client_id + period) porque cobrança extra de mensalidade no mesmo
   mês é legítima; já a segunda implantação do mesmo cliente no mesmo mês é sempre
   duplicidade — e era por aqui que ela entrava quando alguém lançava pelo link da
   equipe, pulando o aviso da tela. O serviço diz "não" com 409 e a mensagem que a
   tela mostra. Cancelado não conta: cancelar é exatamente o caminho para poder
   lançar de novo. */
async function assertUnicaImplementacao(row, ignoreId) {
  if (row.kind !== 'Implementação' || row.status === 'Cancelado') return;
  const coluna = row.client_id ? 'client_id' : (row.sale_id ? 'sale_id' : null);
  if (!coluna) return;
  const month = normalizePeriod(row.period || row.due_date || row.paid_at);
  const { data, error } = await supabase
    .from('finance_payments')
    .select('id, status, period, due_date, paid_at')
    .eq(coluna, row[coluna])
    .eq('kind', 'Implementação')
    .neq('status', 'Cancelado')
    .limit(500);
  if (error) throw dbError(error, 'Falha ao conferir a implantação deste mês.');
  const existente = (data || []).find(p => p.id !== ignoreId &&
    normalizePeriod(p.period || p.due_date || p.paid_at) === month);
  if (!existente) return;
  throw new ApiError(409,
    `A implantação de ${monthLabel(month)} já foi lançada para ${row.company || 'este cliente'}. ` +
    'Cancele o lançamento existente para poder cobrar de novo.');
}

/* company é gravado junto (snapshot): a lista de recebimentos continua legível
   mesmo se o cliente mudar de nome depois, e sem pagar um join a mais. */
async function createPayment(payload) {
  assertReady();
  const target = await assertTarget(payload);
  const row = paymentMap.toRow(payload);
  if (!row.id) row.id = newId('rc');
  if (!row.company) row.company = target.company || '';
  if (!row.status) row.status = 'Pendente';
  if (!row.kind) row.kind = 'Implementação';
  if (row.period) row.period = normalizePeriod(row.period);
  if (row.status === 'Pago' && !row.paid_at) row.paid_at = new Date().toISOString();
  await assertUnicaImplementacao(row);
  const { data, error } = await supabase.from('finance_payments').insert(row).select().single();
  if (error) {
    if (error.code === '23505' && row.client_id && row.period) {
      throw new ApiError(409, `Já existe um lançamento de ${monthLabel(row.period)} para ${target.company || 'este cliente'}.`);
    }
    throw dbError(error, 'Falha ao lançar o recebimento.');
  }
  return paymentMap.fromRow(data);
}

/* Pago/desfeito é um PATCH de status — quem preenche paid_at é o service, para
   a tela não precisar acertar a hora em dois lugares diferentes. */
async function updatePayment(id, patch) {
  assertReady();
  const atual = await getPayment(id);
  if (patch.clientId || patch.saleId) {
    const clientId = patch.clientId !== undefined ? patch.clientId : atual.clientId;
    const saleId = patch.saleId !== undefined ? patch.saleId : atual.saleId;
    await assertTarget({ clientId, saleId });
  }
  const row = paymentMap.toRow(patch);
  delete row.id;
  if (row.status === 'Pago' && !row.paid_at && !atual.paidAt) row.paid_at = new Date().toISOString();
  if (row.status && row.status !== 'Pago') row.paid_at = null;
  if (row.period) row.period = normalizePeriod(row.period);
  if (Object.keys(row).length === 0) return atual;
  /* A mesma regra da criação, agora no lado de quem corrige: mudar o vencimento,
     o tipo ou marcar como pago não pode fazer a linha virar uma segunda
     implantação no mês de outra que já existe. A própria linha é ignorada. */
  await assertUnicaImplementacao({
    kind: row.kind !== undefined ? row.kind : atual.kind,
    status: row.status !== undefined ? row.status : atual.status,
    company: row.company !== undefined ? row.company : atual.company,
    client_id: row.client_id !== undefined ? row.client_id : atual.clientId,
    sale_id: row.sale_id !== undefined ? row.sale_id : atual.saleId,
    period: row.period !== undefined ? row.period : atual.period,
    due_date: row.due_date !== undefined ? row.due_date : atual.dueDate,
    paid_at: row.paid_at !== undefined ? row.paid_at : atual.paidAt,
  }, atual.id);
  const { data, error } = await supabase.from('finance_payments').update(row).eq('id', id).select().single();
  if (error) throw dbError(error, 'Falha ao atualizar o recebimento.');
  return paymentMap.fromRow(data);
}

/* Excluir lançamento errado é o único DELETE do Financeiro — e só do
   recebimento. A linha digitada errada não tem valor de histórico, e deixar
   "Cancelado" para sempre na lista é o que confunde quem abre a tela todo dia.
   A confirmação (nome + valor + "não tem volta") é na tela; o service só garante
   que não apaga o que não existe, devolvendo 404 em vez de sucesso falso. */
async function deletePayment(id) {
  assertReady();
  const atual = await getPayment(id);
  const { error } = await supabase.from('finance_payments').delete().eq('id', id);
  if (error) throw dbError(error, 'Falha ao excluir o recebimento.');
  return atual;
}

/* Gera uma parcela de mensalidade Pendente por cliente ativo que cobra
   mensalidade e ainda não tem lançamento naquele mês. Idempotente por
   (client_id, period): rodar duas vezes no mesmo mês não dobra nada — por isso
   o retorno traz criados e pulados, e a tela conta os dois. */
async function generateRecurring({ period }) {
  assertReady();
  const month = normalizePeriod(period) || normalizePeriod(new Date());
  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, company, monthly_value, owner')
    .eq('status', 'Ativo')
    .gt('monthly_value', 0)
    .limit(2000);
  if (error) throw dbError(error, 'Falha ao consultar os clientes com mensalidade.');
  if (!clients || !clients.length) return { period: month, created: [], skipped: 0, total: 0 };

  const ids = clients.map(c => c.id);
  const { data: existentes, error: erroExistentes } = await supabase
    .from('finance_payments')
    .select('client_id')
    .eq('period', month)
    .in('client_id', ids);
  if (erroExistentes) throw dbError(erroExistentes, 'Falha ao consultar os lançamentos do mês.');
  const jaTem = new Set((existentes || []).map(p => p.client_id));

  const faltando = clients.filter(c => !jaTem.has(c.id));
  if (!faltando.length) return { period: month, created: [], skipped: clients.length, total: 0 };

  const rotulo = monthLabel(month);
  const rows = faltando.map(c => ({
    id: newId('rc'),
    client_id: c.id,
    company: c.company,
    description: `Mensalidade de ${rotulo}`,
    amount: Number(c.monthly_value) || 0,
    kind: 'Mensalidade',
    due_date: month,
    period: month,
    status: 'Pendente',
    method: '',
    notes: '',
  }));

  const { data: criadas, error: erroInsert } = await supabase
    .from('finance_payments')
    .insert(rows)
    .select();
  if (erroInsert) {
    /* Corrida entre duas abas: o índice único derruba o segundo insert. O
       resultado honesto é "já estavam lançadas", não um erro vermelho. */
    if (erroInsert.code === '23505') {
      const { data: depois } = await supabase.from('finance_payments').select('client_id').eq('period', month);
      const jaLancado = new Set((depois || []).map(p => p.client_id));
      return { period: month, created: [], skipped: clients.filter(c => jaLancado.has(c.id)).length, total: 0 };
    }
    throw dbError(erroInsert, 'Falha ao gerar as mensalidades.');
  }

  const created = (criadas || []).map(paymentMap.fromRow);
  return {
    period: month,
    created,
    skipped: clients.length - created.length,
    total: created.reduce((sum, p) => sum + (Number(p.amount) || 0), 0),
  };
}

/* -------------------------------- comissão -------------------------------- */

/* Uma linha só ('padrao'). Se a migração rodou sem o insert (ou alguém limpou a
   tabela), criar aqui de novo é melhor do que deixar a tela sem número nenhum. */
async function getSettings() {
  assertReady();
  const { data, error } = await supabase.from('finance_settings').select('*').eq('id', 'padrao').maybeSingle();
  if (error) throw dbError(error, 'Falha ao consultar as configurações do Financeiro.');
  if (data) return settingsMap.fromRow(data);
  const { data: criada, error: erroInsert } = await supabase
    .from('finance_settings')
    .insert({ id: 'padrao', commission_percent: 10 })
    .select()
    .single();
  if (erroInsert) throw dbError(erroInsert, 'Falha ao criar as configurações do Financeiro.');
  return settingsMap.fromRow(criada);
}

async function saveSettings(commissionPercent) {
  const atual = await getSettings();
  if (!Number.isFinite(commissionPercent)) throw new ApiError(400, 'Percentual de comissão inválido.');
  const { data, error } = await supabase
    .from('finance_settings')
    .update({ commission_percent: commissionPercent })
    .eq('id', atual.id)
    .select()
    .single();
  if (error) throw dbError(error, 'Falha ao salvar o percentual de comissão.');
  return settingsMap.fromRow(data);
}

module.exports = {
  listSales,
  getSale,
  createSale,
  updateSale,
  listPayments,
  getPayment,
  createPayment,
  updatePayment,
  deletePayment,
  generateRecurring,
  getSettings,
  saveSettings,
  SALE_COLUMNS,
  PAYMENT_COLUMNS,
  SETTINGS_COLUMNS,
};
