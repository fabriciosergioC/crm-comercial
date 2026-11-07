-- ============================================================================
--  Migração 014 - Financeiro (vendas avulsas, recebimentos e comissão)
--  Arquivo: backend/database/migrations/014_financeiro.sql
--  ---------------------------------------------------------------------------
--  Cole no SQL Editor do Supabase e execute UMA vez. Nada aqui apaga tabela ou
--  linha existente: são três tabelas novas, índices, RLS e o trigger de
--  updated_at (a função public.set_updated_at já existe desde a 001).
--
--  Por que três tabelas:
--    finance_sales     -> só as vendas LANÇADAS À MÃO (serviço avulso, bico).
--                         A venda que nasce de um Cliente fechado NÃO é copiada
--                         para aqui: a tela lê o próprio clients (valor
--                         contratado + mensalidade) e junta na hora. Copiar
--                         seria ter dois valores para conferir.
--    finance_payments  -> cada recebimento (parcela, mensalidade, avulso).
--                         Aponta para UM destino: client_id (cliente fechado)
--                         OU sale_id (venda avulsa) - nunca os dois, nunca
--                         nenhum (ver finance_payments_target_chk).
--    finance_settings  -> a linha única 'padrao' com o percentual de comissão,
--                         para o número ser o mesmo para quem abrir pela equipe.
--
--  Sem DELETE em nada: lançamento errado muda de status ('Cancelada',
--  'Cancelado') e some das somas, mas a linha fica para a prova de auditoria.
--
--  Idempotente: pode rodar de novo sem estragar nada (if not exists / on
--  conflict do nothing / drop trigger if exists).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- finance_sales - venda avulsa lançada direto na tela Financeiro.
--   owner tem FK para users: o mesmo usuário que entra no CRM precisa existir
--   na tabela users, senão o insert volta 400 (regra já usada em clients).
-- ----------------------------------------------------------------------------
create table if not exists public.finance_sales (
  id          text          primary key,
  company     text          not null,
  description text          not null default '',
  value       numeric(12,2) not null default 0,
  kind        text          not null default 'Serviço avulso',
  sale_date   timestamptz   not null default now(),
  owner       text          references public.users (id),
  status      text          not null default 'Ativa',
  notes       text          not null default '',
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),
  constraint fs_value_chk check (value >= 0),
  constraint fs_kind_chk check (kind in (
    'Implementação', 'Mensalidade', 'Serviço avulso', 'Outro')),
  constraint fs_status_chk check (status in ('Ativa', 'Cancelada'))
);

create index if not exists finance_sales_sale_date_idx on public.finance_sales (sale_date);
create index if not exists finance_sales_owner_idx     on public.finance_sales (owner);
create index if not exists finance_sales_status_idx    on public.finance_sales (status);

alter table public.finance_sales enable row level security;
revoke all on table public.finance_sales from anon, authenticated;
grant all on table public.finance_sales to service_role;

drop trigger if exists finance_sales_set_updated_at on public.finance_sales;
create trigger finance_sales_set_updated_at
  before update on public.finance_sales
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- finance_payments - um recebimento (o que entrou, ou está para entrar).
--   period  -> primeiro dia do mês, quando a linha é uma mensalidade recorrente.
--              Serve para "gerar as mensalidades do mês" sem gerar duas vezes:
--              o índice único abaixo barra o segundo lançamento do mesmo cliente
--              no mesmo mês (com period nulo o índice não se aplica, porque é
--              parcial: só linha com client_id E period preenchidos).
--   status  -> 'Pendente' (a receber), 'Pago' (entrou; paid_at preenchido) ou
--              'Cancelado' (lançado por engano; some de todas as somas).
--   atraso NÃO é status: é consequência de due_date < hoje e status Pendente,
--              calculado na tela, para ninguém precisar "marcar atrasado".
-- ----------------------------------------------------------------------------
create table if not exists public.finance_payments (
  id          text          primary key,
  client_id   text          references public.clients (id),
  sale_id     text          references public.finance_sales (id),
  company     text          not null,
  description text          not null default '',
  amount      numeric(12,2) not null default 0,
  kind        text          not null default 'Implementação',
  due_date    date,
  period      date,
  paid_at     timestamptz,
  method      text          not null default '',
  status      text          not null default 'Pendente',
  notes       text          not null default '',
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),
  constraint fp_amount_chk check (amount >= 0),
  constraint fp_target_chk check (
    (client_id is not null and sale_id is null) or
    (client_id is null and sale_id is not null)
  ),
  constraint fp_kind_chk check (kind in (
    'Implementação', 'Mensalidade', 'Serviço avulso', 'Outro')),
  constraint fp_method_chk check (method in (
    '', 'PIX', 'Boleto', 'Cartão', 'Dinheiro', 'Transferência')),
  constraint fp_status_chk check (status in ('Pendente', 'Pago', 'Cancelado'))
);

create index if not exists finance_payments_due_date_idx  on public.finance_payments (due_date);
create index if not exists finance_payments_status_idx    on public.finance_payments (status);
create index if not exists finance_payments_client_idx    on public.finance_payments (client_id);
create index if not exists finance_payments_sale_idx      on public.finance_payments (sale_id);

create unique index if not exists finance_payments_client_period_uidx
  on public.finance_payments (client_id, period)
  where client_id is not null and period is not null;

alter table public.finance_payments enable row level security;
revoke all on table public.finance_payments from anon, authenticated;
grant all on table public.finance_payments to service_role;

drop trigger if exists finance_payments_set_updated_at on public.finance_payments;
create trigger finance_payments_set_updated_at
  before update on public.finance_payments
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- finance_settings - a linha única 'padrao' com o percentual de comissão.
-- ----------------------------------------------------------------------------
create table if not exists public.finance_settings (
  id                 text          primary key,
  commission_percent numeric(5,2)  not null default 10,
  updated_at         timestamptz   not null default now(),
  constraint fst_commission_chk check (commission_percent >= 0 and commission_percent <= 100)
);

insert into public.finance_settings (id, commission_percent)
  values ('padrao', 10)
  on conflict (id) do nothing;

alter table public.finance_settings enable row level security;
revoke all on table public.finance_settings from anon, authenticated;
grant all on table public.finance_settings to service_role;

drop trigger if exists finance_settings_set_updated_at on public.finance_settings;
create trigger finance_settings_set_updated_at
  before update on public.finance_settings
  for each row execute function public.set_updated_at();
