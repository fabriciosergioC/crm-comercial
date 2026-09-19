-- ============================================================================
--  Sistema CRM - Estrutura do banco de dados (Supabase / PostgreSQL)
--  Arquivo: backend/database/schema.sql
--  ---------------------------------------------------------------------------
--  Cria TABELAS, CONSTRAINTS, ÍNDICES e TRIGGERS.
--
--  Garantias deste arquivo:
--    * NÃO apaga nada (nenhum DROP TABLE / DROP DATABASE / TRUNCATE);
--    * pode ser reexecutado sem erro (CREATE ... IF NOT EXISTS);
--    * não inventa colunas: cada campo existe hoje no front-end (initialDb)
--      ou é exigido por leadsService.js / statusHistoryService.js.
--
--  Ordem de execução: schema.sql -> functions.sql -> rls.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- users - vendedores/donos. Espelha a constante USERS do front-end
--         ({ id: "erick" }, { id: "fabricio" }).
--         Referenciado por leads.owner, lead_interactions."user",
--         lead_followups.created_by, lead_demos.owner e clients.owner.
--         password_hash armazena apenas o hash seguro da senha. Um usuário sem
--         hash usa a senha padrão configurada no backend e precisa trocá-la no
--         primeiro acesso.
-- ----------------------------------------------------------------------------
create table if not exists public.users (
  id                    text        primary key,
  name                  text        not null,
  active                boolean     not null default true,
  password_hash         text,
  must_change_password  boolean     not null default true,
  password_updated_at   timestamptz,
  created_at            timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- leads - entidade central: a oportunidade comercial.
--   Colunas em snake_case exatamente como o mapeamento COLUMNS de
--   leadsService.js espera.
--   * next_action e score são jsonb (ver JSONB_FIELDS em leadsService.js).
--   * last_contact_at e temperature são atualizados pela função
--     add_lead_interaction (functions.sql) - a temperatura só sobe.
--   * loss_reason é nullable: o front-end muda o status para "Perdido" e grava
--     o motivo em uma segunda chamada, então exigir NOT NULL quebraria o fluxo.
-- ----------------------------------------------------------------------------
create table if not exists public.leads (
  id              text primary key,
  company         text        not null,
  contact_name    text        not null,
  phone           text,
  whatsapp        text,
  instagram       text,
  gmaps           text,
  current_site    text,
  city            text,
  neighborhood    text,
  segment         text,
  notes           text        not null default '',
  owner           text        not null references public.users (id),
  priority        text        not null default 'Média',
  temperature     text        not null default 'Frio',
  source          text,
  status          text        not null default 'Novo',
  created_at      timestamptz not null default now(),
  last_contact_at timestamptz,
  loss_reason     text,
  next_action     jsonb,
  score           jsonb       not null default '{"dor":0,"facilidade":0,"pagamento":0,"recorrencia":0}'::jsonb,
  updated_at      timestamptz not null default now(),

  constraint leads_priority_chk check (priority in ('Baixa','Média','Alta')),
  constraint leads_temperature_chk check (temperature in ('Frio','Morno','Quente')),
  constraint leads_status_chk check (status in (
    'Novo','Contato pendente','Contatado','Respondeu','Demo enviada','Demo em análise',
    'Interessado','Proposta enviada','Negociação','Fechado','Perdido')),
  constraint leads_source_chk check (source is null or source in (
    'Indicação','Instagram','Google','Prospecção ativa','Site','Outro')),
  constraint leads_segment_chk check (segment is null or segment in (
    'Alimentação','Saúde','Fitness','Jurídico','Beleza','Imóveis','Móveis','Pet',
    'Estética','Contabilidade','Automotivo','Eventos','Arquitetura')),
  constraint leads_loss_reason_chk check (loss_reason is null or loss_reason in (
    'Preço','Não precisa','Já possui site','Escolheu concorrente','Sem orçamento',
    'Momento inadequado','Sem resposta','Outro')),
  constraint leads_next_action_chk check (
    next_action is null or jsonb_typeof(next_action) = 'object'),
  constraint leads_score_chk check (
    jsonb_typeof(score) = 'object'
    and (score->>'dor'         is null or (score->>'dor')         ~ '^[0-5]$')
    and (score->>'facilidade'  is null or (score->>'facilidade')  ~ '^[0-5]$')
    and (score->>'pagamento'   is null or (score->>'pagamento')   ~ '^[0-5]$')
    and (score->>'recorrencia' is null or (score->>'recorrencia') ~ '^[0-5]$'))
);

comment on table  public.leads is 'Oportunidades comerciais (entidade central do CRM).';
comment on column public.leads.next_action is 'jsonb {date, note} - próxima ação combinada.';
comment on column public.leads.score is 'jsonb {dor, facilidade, pagamento, recorrencia} - notas de 0 a 5.';
comment on column public.leads.loss_reason is 'Preenchido quando status = Perdido.';
comment on column public.leads.owner is 'users.id do responsável pelo lead.';
-- ----------------------------------------------------------------------------
-- lead_status_history - auditoria das mudanças de status.
--   Colunas iguais às que statusHistoryService.js lê (from_status, to_status,
--   date, "user").
-- ----------------------------------------------------------------------------
create table if not exists public.lead_status_history (
  id          text        primary key,
  lead_id     text        not null references public.leads (id) on delete cascade,
  from_status text,
  to_status   text        not null,
  date        timestamptz not null default now(),
  "user"      text        references public.users (id),
  created_at  timestamptz not null default now(),
  constraint lsh_from_chk check (from_status is null or from_status in (
    'Novo','Contato pendente','Contatado','Respondeu','Demo enviada','Demo em análise',
    'Interessado','Proposta enviada','Negociação','Fechado','Perdido')),
  constraint lsh_to_chk check (to_status in (
    'Novo','Contato pendente','Contatado','Respondeu','Demo enviada','Demo em análise',
    'Interessado','Proposta enviada','Negociação','Fechado','Perdido'))
);

-- ----------------------------------------------------------------------------
-- lead_interactions - contatos realizados (alimenta relatórios e a temperatura).
-- ----------------------------------------------------------------------------
create table if not exists public.lead_interactions (
  id         text        primary key,
  lead_id    text        not null references public.leads (id) on delete cascade,
  date       timestamptz not null default now(),
  "user"     text        references public.users (id),
  channel    text        not null,
  result     text        not null,
  note       text        not null default '',
  created_at timestamptz not null default now(),
  constraint li_channel_chk check (channel in (
    'Ligação','WhatsApp','Instagram','E-mail','Presencial','Outro')),
  constraint li_result_chk check (result in (
    'Não atendeu','Atendeu','Pediu retorno','Respondeu','Demo enviada',
    'Demonstrou interesse','Pediu preço','Pediu proposta','Sem interesse',
    'Número inválido','Outro'))
);

-- ----------------------------------------------------------------------------
-- lead_followups - tarefas de retorno.
--   O status inclui 'cancelado', usado no front-end (reagendar/cancelar), que
--   AINDA NÃO existe em backend/models/enums.js (FOLLOWUP_STATUSES). É uma
--   divergência já reportada: a validação de servidor precisa de 1 linha lá.
-- ----------------------------------------------------------------------------
create table if not exists public.lead_followups (
  id         text        primary key,
  lead_id    text        not null references public.leads (id) on delete cascade,
  due_date   timestamptz,
  note       text        not null default '',
  status     text        not null default 'pendente',
  created_by text        references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lf_status_chk check (status in ('pendente','concluido','cancelado'))
);

-- ----------------------------------------------------------------------------
-- lead_demos - prévias enviadas ao cliente (validade padrão de 24h).
--   views / last_viewed_at ficam nullable: hoje não existe página que os grave.
-- ----------------------------------------------------------------------------
create table if not exists public.lead_demos (
  id             text        primary key,
  lead_id        text        not null references public.leads (id) on delete cascade,
  url            text        not null,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  validity_hours integer     not null default 24,
  expires_at     timestamptz,
  owner          text        references public.users (id),
  deactivated    boolean     not null default false,
  views          integer,
  last_viewed_at timestamptz,
  updated_at     timestamptz not null default now(),
  constraint ld_validity_chk check (validity_hours > 0)
);

-- ----------------------------------------------------------------------------
-- lead_proposals - propostas comerciais enviadas ao lead.
-- ----------------------------------------------------------------------------
create table if not exists public.lead_proposals (
  id                   text          primary key,
  lead_id              text          not null references public.leads (id) on delete cascade,
  plan                 text          not null,
  implementation_value numeric(12,2) not null default 0,
  monthly_value        numeric(12,2) not null default 0,
  proposal_date        timestamptz   not null default now(),
  valid_until          timestamptz,
  notes                text          not null default '',
  status               text          not null default 'Enviada',
  created_at           timestamptz   not null default now(),
  constraint lp_plan_chk check (plan in (
    'Site institucional','Landing page','E-commerce','Site + manutenção mensal')),
  constraint lp_status_chk check (status in (
    'Enviada','Em negociação','Aprovada','Recusada'))
);

-- ----------------------------------------------------------------------------
-- clients - clientes convertidos. Relação 1:1 com o lead (lead_id UNIQUE),
--   como o front-end assume em db.clients.find(c => c.leadId === leadId).
--   status fica SEM CHECK de propósito: a aplicação só usa 'Ativo' hoje e
--   criar outros valores seria inventar regra que não existe.
--   lead_id é nullable (permite cliente sem lead de origem) - o UNIQUE do
--   PostgreSQL aceita vários NULLs.
-- ----------------------------------------------------------------------------
create table if not exists public.clients (
  id               text          primary key,
  lead_id          text          unique references public.leads (id) on delete cascade,
  company          text          not null,
  contact_name     text          not null,
  plan             text          not null,
  contracted_value numeric(12,2) not null default 0,
  monthly_value    numeric(12,2) not null default 0,
  closing_date     timestamptz,
  publish_date     timestamptz,
  domain           text,
  owner            text          references public.users (id),
  notes            text          not null default '',
  status           text          not null default 'Ativo',
  created_at       timestamptz   not null default now(),
  constraint cl_plan_chk check (plan in (
    'Site institucional','Landing page','E-commerce','Site + manutenção mensal'))
);

-- ----------------------------------------------------------------------------
-- client_updates - histórico de alterações do cliente.
--   Existe no modelo do front-end (initialDb.clientUpdates) mas ainda NÃO é
--   consumido pela UI: mantido por paridade do modelo, sem uso hoje.
-- ----------------------------------------------------------------------------
create table if not exists public.client_updates (
  id         text        primary key,
  client_id  text        not null references public.clients (id) on delete cascade,
  date       timestamptz not null default now(),
  type       text        not null,
  note       text        not null default '',
  created_at timestamptz not null default now()
);

-- [fim das tabelas]

-- ----------------------------------------------------------------------------
-- ÍNDICES - cobrem os filtros/ordenações que o front-end já usa hoje
--   (status, responsável, temperatura, prioridade, último contato e próxima
--   ação). Nada de índice "de enfeite".
-- ----------------------------------------------------------------------------
create index if not exists leads_status_idx       on public.leads (status);
create index if not exists leads_owner_idx        on public.leads (owner);
create index if not exists leads_temperature_idx  on public.leads (temperature);
create index if not exists leads_priority_idx     on public.leads (priority);
create index if not exists leads_created_at_idx   on public.leads (created_at desc);
create index if not exists leads_last_contact_idx on public.leads (last_contact_at desc);
create index if not exists leads_next_action_idx  on public.leads (((next_action->>'date')))
  where next_action is not null;

create index if not exists lsh_lead_date_idx  on public.lead_status_history (lead_id, date desc);
create index if not exists li_lead_date_idx   on public.lead_interactions (lead_id, date desc);
create index if not exists li_channel_idx     on public.lead_interactions (channel);
create index if not exists li_user_idx        on public.lead_interactions ("user");
create index if not exists lf_lead_idx        on public.lead_followups (lead_id);
create index if not exists lf_status_due_idx  on public.lead_followups (status, due_date);
create index if not exists ld_lead_idx        on public.lead_demos (lead_id);
create index if not exists ld_expires_idx     on public.lead_demos (expires_at)
  where deactivated = false;
create index if not exists lp_lead_idx        on public.lead_proposals (lead_id);
create index if not exists lp_status_idx      on public.lead_proposals (status);
create index if not exists lp_date_idx        on public.lead_proposals (proposal_date desc);
create index if not exists lp_valid_until_idx on public.lead_proposals (valid_until);
create index if not exists cl_status_idx      on public.clients (status);
create index if not exists cl_owner_idx       on public.clients (owner);
create index if not exists cu_client_date_idx on public.client_updates (client_id, date desc);

-- ----------------------------------------------------------------------------
-- updated_at automático nas tabelas que a aplicação ATUALIZA
--   (leads, lead_followups, lead_demos). As outras são somente-inclusão.
--   O DROP TRIGGER abaixo é apenas para permitir reexecução do arquivo:
--   não toca em dados.
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

drop trigger if exists lead_followups_set_updated_at on public.lead_followups;
create trigger lead_followups_set_updated_at
  before update on public.lead_followups
  for each row execute function public.set_updated_at();

drop trigger if exists lead_demos_set_updated_at on public.lead_demos;
create trigger lead_demos_set_updated_at
  before update on public.lead_demos
  for each row execute function public.set_updated_at();
