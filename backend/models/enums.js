/* Listas de valores espelhadas EXATAMENTE das constantes do front-end
   (STATUS_LIST, TEMPERATURES, PRIORITIES, CHANNELS, RESULTS...), usadas
   para validar a entrada no servidor sem inventar valores novos. */

const STATUS_LIST = [
  'Novo',
  'Contato pendente',
  'MSG 1: Saudação',
  'MSG 2: Apresentação',
  'Contatado',
  'Respondeu',
  'Demo enviada',
  'Demo em análise',
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
  TEMP_RANK,
  HOT_RESULTS,
  WARM_RESULTS,
};
