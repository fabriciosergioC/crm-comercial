/* Listas de valores espelhadas EXATAMENTE das constantes do front-end
   (STATUS_LIST, TEMPERATURES, PRIORITIES, CHANNELS, RESULTS...), usadas
   para validar a entrada no servidor sem inventar valores novos. */

const STATUS_LIST = [
  'Contato pendente',
  'Interessado',
  'Proposta enviada',
  'Negociação',
  'Fechado',
  'Perdido',
];

const TEMPERATURES = ['Frio', 'Morno', 'Quente'];
const PRIORITIES = ['Baixa', 'Média', 'Alta'];
const CHANNELS = ['Ligação', 'WhatsApp', 'Instagram', 'E-mail', 'Presencial', 'Outro'];
const RESULTS = [
  'Não atendeu',
  'Atendeu',
  'Pediu retorno',
  'Respondeu',
  'Demo enviada',
  'Demonstrou interesse',
  'Pediu preço',
  'Pediu proposta',
  'Sem interesse',
  'Número inválido',
  'Outro',
];
const SOURCES = ['Indicação', 'Instagram', 'Google', 'Prospecção ativa', 'Site', 'Outro'];
/* Listas que faltavam para validar entrada na API (os CHECK do banco em
   schema.sql usam exatamente estes valores). Vêm do front-end:
   SEGMENTS (13), LOSS_REASONS (8) e PLANS (4). */
const SEGMENTS = ['Alimentação', 'Saúde', 'Fitness', 'Jurídico', 'Beleza', 'Imóveis', 'Móveis', 'Pet', 'Estética', 'Contabilidade', 'Automotivo', 'Eventos', 'Arquitetura'];
const LOSS_REASONS = ['Preço', 'Não precisa', 'Já possui site', 'Escolheu concorrente', 'Sem orçamento', 'Momento inadequado', 'Sem resposta', 'Outro'];
const PLANS = ['Site institucional', 'Landing page', 'E-commerce', 'Site + manutenção mensal'];
const PROPOSAL_STATUSES = ['Enviada', 'Em negociação', 'Aprovada', 'Recusada'];
/* 'cancelado' é usado pelo front-end (cancelar/reagendar follow-up) e é aceito
   pelo CHECK da tabela lead_followups — mantido em sincronia com o banco. */
const FOLLOWUP_STATUSES = ['pendente', 'concluido', 'cancelado'];
const AGENDA_EVENT_TYPES = ['reuniao', 'demonstracao', 'tarefa', 'compromisso'];
const AGENDA_EVENT_STATUSES = ['agendado', 'concluido', 'cancelado'];

/* Financeiro (migration 014_financeiro.sql). Os mesmos valores aparecem nos
   CHECK do banco — mudar um sem o outro faz o insert voltar 400.
   'Atrasado' NÃO é status: atraso é pendente com due_date no passado, calculado
   na tela, para ninguém ter que marcar atrasado à mão. */
const FINANCE_KINDS = ['Implementação', 'Mensalidade', 'Serviço avulso', 'Outro'];
const FINANCE_SALE_STATUSES = ['Ativa', 'Cancelada'];
const FINANCE_PAYMENT_STATUSES = ['Pendente', 'Pago', 'Cancelado'];
const FINANCE_METHODS = ['', 'PIX', 'Boleto', 'Cartão', 'Dinheiro', 'Transferência'];

/* Regra do front-end (suggestTemperature): a temperatura só sobe, nunca desce. */
const TEMP_RANK = { Frio: 0, Morno: 1, Quente: 2 };
const HOT_RESULTS = ['Demonstrou interesse', 'Pediu preço', 'Pediu proposta'];
const WARM_RESULTS = ['Atendeu', 'Pediu retorno', 'Respondeu', 'Demo enviada'];

module.exports = {
  STATUS_LIST,
  TEMPERATURES,
  PRIORITIES,
  CHANNELS,
  RESULTS,
  SOURCES,
  SEGMENTS,
  LOSS_REASONS,
  PLANS,
  PROPOSAL_STATUSES,
  FOLLOWUP_STATUSES,
  AGENDA_EVENT_TYPES,
  AGENDA_EVENT_STATUSES,
  FINANCE_KINDS,
  FINANCE_SALE_STATUSES,
  FINANCE_PAYMENT_STATUSES,
  FINANCE_METHODS,
  TEMP_RANK,
  HOT_RESULTS,
  WARM_RESULTS,
};
