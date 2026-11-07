const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const financeService = require('../services/financeService');
const usersService = require('../services/usersService');
const { ApiError } = require('../middleware/errorHandler');
const V = require('../middleware/validate');
const {
  FINANCE_KINDS,
  FINANCE_SALE_STATUSES,
  FINANCE_PAYMENT_STATUSES,
  FINANCE_METHODS,
} = require('../models/enums');

/* ===========================================================================
   /api/finance — vendas avulsas, recebimentos e a comissão.

   As vendas vêm de dois lugares e a API responde pelos dois: a tela Financeiro
   junta clients (fechados no CRM) com finance_sales (avulsos lançados aqui),
   então esta rota só precisa expor a parte avulsa.

   DELETE existe só para o recebimento: lançamento digitado errado não tem valor
   de histórico e é o que enche a lista de linha morta (a confirmação é na tela).
   Venda avulsa errada continua virando status 'Cancelada', como em leads,
   follow-ups e propostas.

   Apagar um recebimento e mexer num pagamento que já entrou pedem a senha da
   pessoa, conferida aqui no servidor (ver exigirSenha). Os outros atos — marcar
   pago, ajustar vencimento/método, cancelar um lançamento ainda a receber —
   continuam sem senha: não reescrevem dinheiro que já caiu.
   =========================================================================== */

const router = express.Router();

/* --------------------------- senha de proteção ---------------------------- */

const SENHA_HEADER = 'x-crm-senha';
const USUARIO_HEADER = 'x-crm-usuario';

/* A senha vai em cabeçalho (não em query, que fica em log de proxy, nem no corpo,
   que o PATCH já usa para os campos do lançamento) e é conferida pelo MESMO
   serviço do login: vale a senha com que a pessoa entrou no CRM, inclusive quem
   chega pelo link da equipe. Sem essa conferência aqui do servidor o pedido seria
   só um clique a mais na tela — qualquer um que mexesse no site apagava. */
async function exigirSenha(req, acao) {
  const senha = req.get(SENHA_HEADER) || '';
  const userId = req.get(USUARIO_HEADER) || '';
  if (!senha) throw new ApiError(401, `Digite a sua senha do CRM para ${acao}.`);
  if (!userId) throw new ApiError(401, `Não foi possível identificar quem vai ${acao}.`);
  if (senha.length > 128) throw new ApiError(401, 'Senha não confere — nada foi feito.');
  let resultado;
  try {
    resultado = await usersService.authenticate(userId, senha);
  } catch (err) {
    /* O serviço do login devolve erro de credencial (e 404 para id que não é
       usuário): aqui vira sempre a mesma frase, para a tela não revelar qual
       senha existe. Qualquer outro erro — banco fora do ar, usuário desativado
       — sobe como veio, para a pessoa ver o problema real em vez de achar que
       digitou errado. */
    if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
      throw new ApiError(401, 'Senha não confere — nada foi feito.');
    }
    throw err;
  }
  if (!resultado || !resultado.user) throw new ApiError(401, 'Senha não confere — nada foi feito.');
  return resultado.user;
}

/* O que conta como "mexer num pagamento que já entrou": tirar a linha do status
   Pago ou limpar a data em que o dinheiro caiu. É o "Desfazer" da tela (e o
   "Cancelar" de um lançamento já pago, que faz a mesma soma sair do mês).
   Só a data sendo limpa já denuncia a intenção; o resto (mudar vencimento,
   método, observação) passa sem senha mesmo em linha paga. */
function querDesfazer(body, patch) {
  if (Object.prototype.hasOwnProperty.call(body, 'paidAt') && body.paidAt === null) return true;
  return patch.status !== undefined && patch.status !== 'Pago';
}

async function exigirSenhaSeDesfazer(req, patch, acao) {
  if (!querDesfazer(req.body || {}, patch)) return;
  /* Lê a linha antes para duas coisas: o 404 honesto de id inexistente e o
     status atual — desfazer um lançamento que ainda está a receber não tira
     dinheiro nenhum do mês, então não pede senha. */
  const atual = await financeService.getPayment(req.params.id);
  if (atual.status === 'Pago') await exigirSenha(req, acao);
}

/* Data sem hora (<input type="date">): guardada como 'YYYY-MM-DD', senão o
   vencimento de um cliente entraria como timestamp e o fuso empurraria o dia. */
function dateOnly(body, field, opts = {}) {
  const iso = V.isoDate(body, field, opts);
  return iso ? iso.slice(0, 10) : iso;
}

/* ------------------------------- vendas ---------------------------------- */

const SALE_FIELDS = ['id', 'company', 'description', 'value', 'kind', 'saleDate', 'owner', 'status', 'notes'];

/* GET /api/finance/sales?owner=&status=&kind=&limit= */
router.get('/sales', asyncHandler(async (req, res) => {
  const data = await financeService.listSales(req.query);
  res.json({ success: true, count: data.length, data });
}));

/* POST /api/finance/sales
   { company, description?, value, kind?, saleDate?, owner?, status?, notes? } */
router.post('/sales', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, SALE_FIELDS);
  const payload = {
    id: V.str(body, 'id', { max: 100 }),
    company: V.str(body, 'company', { required: true, max: 200 }),
    description: V.str(body, 'description', { max: 300, allowEmpty: true }),
    value: V.num(body, 'value', { required: true, min: 0, max: 10000000 }),
    kind: V.oneOf(body, 'kind', FINANCE_KINDS),
    saleDate: V.isoDate(body, 'saleDate'),
    owner: V.str(body, 'owner', { max: 100 }),
    status: V.oneOf(body, 'status', FINANCE_SALE_STATUSES),
    notes: V.str(body, 'notes', { max: 2000, allowEmpty: true }),
  };
  const data = await financeService.createSale(payload);
  res.status(201).json({ success: true, data });
}));

/* PATCH /api/finance/sales/:id — mesmo whitelist, tudo opcional. */
router.patch('/sales/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, SALE_FIELDS.filter(f => f !== 'id'));
  const patch = {
    company: V.str(body, 'company', { max: 200 }),
    description: V.str(body, 'description', { max: 300, allowEmpty: true }),
    value: V.num(body, 'value', { min: 0, max: 10000000 }),
    kind: V.oneOf(body, 'kind', FINANCE_KINDS),
    saleDate: V.isoDate(body, 'saleDate'),
    owner: V.str(body, 'owner', { max: 100 }),
    status: V.oneOf(body, 'status', FINANCE_SALE_STATUSES),
    notes: V.str(body, 'notes', { max: 2000, allowEmpty: true }),
  };
  if (Object.values(patch).every(v => v === undefined)) {
    throw new ApiError(400, 'Nenhum campo válido para atualizar.');
  }
  const data = await financeService.updateSale(req.params.id, patch);
  res.json({ success: true, data });
}));

/* ---------------------------- recebimentos ------------------------------- */

const PAYMENT_FIELDS = ['id', 'clientId', 'saleId', 'company', 'description', 'amount',
  'kind', 'dueDate', 'period', 'paidAt', 'method', 'status', 'notes'];

/* GET /api/finance/payments?clientId=&saleId=&status=&kind=&period=&limit= */
router.get('/payments', asyncHandler(async (req, res) => {
  const data = await financeService.listPayments(req.query);
  res.json({ success: true, count: data.length, data });
}));

/* POST /api/finance/payments
   { clientId | saleId, company?, description?, amount, kind?, dueDate?,
     period?, paidAt?, method?, status?, notes? }
   company é opcional de propósito: sem ele o service copia o nome do cliente ou
   da venda, então o lançamento nunca chega na lista sem identificação. */
router.post('/payments', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, PAYMENT_FIELDS);
  const payload = {
    id: V.str(body, 'id', { max: 100 }),
    clientId: V.str(body, 'clientId', { max: 100 }),
    saleId: V.str(body, 'saleId', { max: 100 }),
    company: V.str(body, 'company', { max: 200 }),
    description: V.str(body, 'description', { max: 300, allowEmpty: true }),
    amount: V.num(body, 'amount', { required: true, min: 0, max: 10000000 }),
    kind: V.oneOf(body, 'kind', FINANCE_KINDS),
    dueDate: dateOnly(body, 'dueDate'),
    period: V.str(body, 'period', { max: 40 }),
    paidAt: V.isoDate(body, 'paidAt'),
    method: V.oneOf(body, 'method', FINANCE_METHODS),
    status: V.oneOf(body, 'status', FINANCE_PAYMENT_STATUSES),
    notes: V.str(body, 'notes', { max: 2000, allowEmpty: true }),
  };
  const data = await financeService.createPayment(payload);
  res.status(201).json({ success: true, data });
}));

/* POST /api/finance/payments/recorrentes  { period? }
   Gera a mensalidade pendente de cada cliente ativo que cobra mensalidade e
   ainda não tem lançamento naquele mês. Repetir o mesmo mês não duplica. */
router.post('/payments/recorrentes', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['period']);
  const data = await financeService.generateRecurring({ period: V.str(body, 'period', { max: 40 }) });
  res.status(201).json({ success: true, data });
}));

/* PATCH /api/finance/payments/:id
   'Marcar como pago' é { status: 'Pago' } — paid_at é preenchido pelo service.
   O caminho inverso (desfazer um pagamento que já entrou) pede a senha; ver
   exigirSenhaSeDesfazer. */
router.patch('/payments/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, PAYMENT_FIELDS.filter(f => f !== 'id'));
  const patch = {
    clientId: V.str(body, 'clientId', { max: 100 }),
    saleId: V.str(body, 'saleId', { max: 100 }),
    company: V.str(body, 'company', { max: 200 }),
    description: V.str(body, 'description', { max: 300, allowEmpty: true }),
    amount: V.num(body, 'amount', { min: 0, max: 10000000 }),
    kind: V.oneOf(body, 'kind', FINANCE_KINDS),
    dueDate: dateOnly(body, 'dueDate'),
    period: V.str(body, 'period', { max: 40 }),
    paidAt: V.isoDate(body, 'paidAt'),
    method: V.oneOf(body, 'method', FINANCE_METHODS),
    status: V.oneOf(body, 'status', FINANCE_PAYMENT_STATUSES),
    notes: V.str(body, 'notes', { max: 2000, allowEmpty: true }),
  };
  if (Object.values(patch).every(v => v === undefined)) {
    throw new ApiError(400, 'Nenhum campo válido para atualizar.');
  }
  await exigirSenhaSeDesfazer(req, patch, 'desfazer um recebimento que já entrou');
  const data = await financeService.updatePayment(req.params.id, patch);
  res.json({ success: true, data });
}));

/* DELETE /api/finance/payments/:id
   O único delete do Financeiro, para o lançamento registrado errado. Devolve a
   linha que foi embora (a tela já mostrou o nome e o valor na confirmação) e
   responde 404 honesto se o id não existe — nada de sucesso falso.
   Aqui a senha é sempre obrigatória: apagar é o ato sem volta da tela. */
router.delete('/payments/:id', asyncHandler(async (req, res) => {
  await exigirSenha(req, 'excluir um recebimento');
  const data = await financeService.deletePayment(req.params.id);
  res.json({ success: true, data });
}));

/* ------------------------------- comissão -------------------------------- */

/* GET /api/finance/settings -> { commissionPercent } */
router.get('/settings', asyncHandler(async (req, res) => {
  const data = await financeService.getSettings();
  res.json({ success: true, data });
}));

/* PATCH /api/finance/settings  { commissionPercent } */
router.patch('/settings', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['commissionPercent']);
  const percent = V.num(body, 'commissionPercent', { required: true, min: 0, max: 100 });
  const data = await financeService.saveSettings(percent);
  res.json({ success: true, data });
}));

module.exports = router;
