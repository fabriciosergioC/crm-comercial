-- ============================================================================
-- BANCO NOVO — cole este arquivo inteiro no SQL Editor de um projeto Supabase
-- zerado e clique em Run. É o caminho de recuperação quando o projeto antigo
-- foi apagado/pausado e o .env passou a apontar para um projeto novo.
--
-- Gerado por concatenação, NÃO edite à mão:
--   apply_all.sql                       (10 tabelas + 3 RPC + RLS, já com 011/012/013)
--   migrations/005_whatsapp_baileys.sql (whatsapp_conversations + whatsapp_messages)
--   migrations/014_financeiro.sql       (finance_sales/payments/settings + seed)
--   + o seed dos dois usuários do login, no fim
--
-- Nada aqui apaga dado: são só create ... if not exists, grants e triggers.
-- Depois de rodar, o login funciona com a senha inicial compartilhada
-- (DEFAULT_PASSWORD do backend) e o CRM obriga a trocar no primeiro acesso.
-- ============================================================================


-- ============================================================================
--  GERADO AUTOMATICAMENTE a partir de schema.sql + functions.sql + rls.sql
--  NAO edite este arquivo a mao - a fonte sao os 3 arquivos acima.
--  Uso: cole TODO o conteudo deste arquivo no SQL Editor do Supabase e RUN.
--  Nao apaga nada: apenas CREATE/ALTER/REVOKE/GRANT.
-- ============================================================================

-- #################### INICIO schema.sql ####################

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
  status          text        not null default 'Contato pendente',
  created_at      timestamptz not null default now(),
  last_contact_at timestamptz,
  loss_reason     text,
  next_action     jsonb,
  score           jsonb       not null default '{"dor":0,"facilidade":0,"pagamento":0,"recorrencia":0}'::jsonb,
  updated_at      timestamptz not null default now(),

  constraint leads_priority_chk check (priority in ('Baixa','Média','Alta')),
  constraint leads_temperature_chk check (temperature in ('Frio','Morno','Quente')),
  constraint leads_status_chk check (status in (
    'Contato pendente','Interessado','Proposta enviada','Negociação',
    'Fechado','Perdido')),
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
--   Os CHECKs abaixo aceitam 'Novo', 'Contatado' e 'Respondeu' DE PROPÓSITO:
--   essas três etapas saíram do funil em 12/10/2026 (migração 012), mas o
--   histórico já gravado continua legível. A tabela leads não aceita mais
--   nenhum dos três.
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
    'Novo','Contato pendente','Contatado','Respondeu',
    'Demo enviada','Demo em análise','Interessado','Proposta enviada',
    'Negociação','Fechado','Perdido')),
  constraint lsh_to_chk check (to_status in (
    'Novo','Contato pendente','Contatado','Respondeu',
    'Demo enviada','Demo em análise','Interessado','Proposta enviada',
    'Negociação','Fechado','Perdido'))
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
  notified_at timestamptz,
  constraint lf_status_chk check (status in ('pendente','concluido','cancelado'))
);

-- ----------------------------------------------------------------------------
-- agenda_events - reuniões, demonstrações agendadas, tarefas e compromissos.
-- Retornos continuam usando lead_followups para manter o fluxo existente.
-- ----------------------------------------------------------------------------
create table if not exists public.agenda_events (
  id         text        primary key,
  type       text        not null,
  title      text        not null,
  event_at   timestamptz not null,
  lead_id    text        references public.leads (id) on delete cascade,
  owner      text        references public.users (id),
  notes      text        not null default '',
  status     text        not null default 'agendado',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agenda_event_type_chk check (type in ('reuniao','demonstracao','tarefa','compromisso')),
  constraint agenda_event_status_chk check (status in ('agendado','concluido','cancelado'))
);

create index if not exists agenda_events_event_at_idx on public.agenda_events (event_at);
create index if not exists agenda_events_lead_id_idx on public.agenda_events (lead_id);

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
create index if not exists lf_pending_notify_idx on public.lead_followups (due_date)
  where status = 'pendente' and notified_at is null;
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
--   (leads, lead_followups, agenda_events, lead_demos).
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

drop trigger if exists agenda_events_set_updated_at on public.agenda_events;
create trigger agenda_events_set_updated_at
  before update on public.agenda_events
  for each row execute function public.set_updated_at();

drop trigger if exists lead_demos_set_updated_at on public.lead_demos;
create trigger lead_demos_set_updated_at
  before update on public.lead_demos
  for each row execute function public.set_updated_at();

-- #################### FIM schema.sql ####################

-- #################### INICIO functions.sql ####################

-- ============================================================================
--  Sistema CRM - Funções (RPC) do banco (Supabase / PostgreSQL)
--  Arquivo: backend/database/functions.sql
--  ---------------------------------------------------------------------------
--  Estas duas funções existem porque as operações correspondentes no front-end
--  mudam DUAS coisas de uma vez e precisam ser atômicas:
--    1) change_lead_status .... muda o status E grava o histórico;
--    2) add_lead_interaction .. grava a interação E atualiza o lead
--                               (last_contact_at + temperatura).
--
--  Os nomes/tipos/formatos de retorno abaixo foram escritos para casar
--  EXATAMENTE com o que backend/services/leadsService.js já chama - portanto
--  os services existentes NÃO precisam ser alterados:
--
--    supabase.rpc('change_lead_status', { p_lead_id, p_to, p_user })
--      -> { lead, entry: { id, lead_id, from_status, to_status, date, user } }
--    supabase.rpc('add_lead_interaction',
--      { p_lead_id, p_user, p_channel, p_result, p_note })
--      -> { lead, interaction: { id, lead_id, date, user, channel, result, note } }
--
--  Não apaga nada. Pode ser reexecutado (CREATE OR REPLACE FUNCTION).
--  Ordem de execução: schema.sql -> functions.sql -> rls.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- change_lead_status - muda o status do lead e registra o histórico de forma
--   atômica. p_loss_reason é opcional (DEFAULT NULL), então a chamada atual do
--   service continua funcionando sem alteração.
-- ----------------------------------------------------------------------------
create or replace function public.change_lead_status(
  p_lead_id     text,
  p_to          text,
  p_user        text default null,
  p_loss_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from  text;
  v_lead  jsonb;
  v_entry jsonb;
begin
  if p_to is null or p_to not in (
      'Contato pendente','Interessado','Proposta enviada','Negociação',
      'Fechado','Perdido') then
    raise exception 'Status inválido: %', p_to using errcode = '22023';
  end if;

  select l.status into v_from
    from public.leads l
   where l.id = p_lead_id
     for update;

  if not found then
    raise exception 'Lead % não encontrado.', p_lead_id using errcode = 'P0002';
  end if;

  update public.leads
     set status      = p_to,
         loss_reason = case
                         when p_to = 'Perdido' and p_loss_reason is not null then p_loss_reason
                         else loss_reason
                       end,
         updated_at  = now()
   where id = p_lead_id;

  insert into public.lead_status_history (id, lead_id, from_status, to_status, date, "user")
  values ('sh_' || gen_random_uuid()::text, p_lead_id, v_from, p_to, now(), p_user)
  returning jsonb_build_object(
    'id',          id,
    'lead_id',     lead_id,
    'from_status', from_status,
    'to_status',   to_status,
    'date',        date,
    'user',        "user"
  ) into v_entry;

  select to_jsonb(l) into v_lead from public.leads l where l.id = p_lead_id;

  return jsonb_build_object('lead', v_lead, 'entry', v_entry);
end;
$$;
-- ----------------------------------------------------------------------------
-- add_lead_interaction - registra a interação e atualiza o lead
--   (last_contact_at + temperatura sugerida) de forma atômica.
--   A regra da temperatura é a MESMA do front-end (suggestTemperature) e de
--   backend/models/enums.js (TEMP_RANK / HOT_RESULTS / WARM_RESULTS):
--     * resultados "quentes" -> Quente
--     * resultados "mornos"  -> Morno (apenas se o lead estiver Frio)
--     * a temperatura SÓ SOBE, nunca desce.
-- ----------------------------------------------------------------------------
create or replace function public.add_lead_interaction(
  p_lead_id text,
  p_user    text,
  p_channel text,
  p_result  text,
  p_note    text default ''
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now       timestamptz := now();
  v_current   text;
  v_suggested text;
  v_final     text;
  v_rank_cur  integer;
  v_rank_sug  integer;
  v_lead      jsonb;
  v_inter     jsonb;
begin
  if p_channel is null or p_channel not in (
      'Ligação','WhatsApp','Instagram','E-mail','Presencial','Outro') then
    raise exception 'Canal inválido: %', p_channel using errcode = '22023';
  end if;

  if p_result is null or p_result not in (
      'Não atendeu','Atendeu','Pediu retorno','Respondeu','Demo enviada',
      'Demonstrou interesse','Pediu preço','Pediu proposta','Sem interesse',
      'Número inválido','Outro') then
    raise exception 'Resultado inválido: %', p_result using errcode = '22023';
  end if;

  select l.temperature into v_current
    from public.leads l
   where l.id = p_lead_id
     for update;

  if not found then
    raise exception 'Lead % não encontrado.', p_lead_id using errcode = 'P0002';
  end if;

  if p_result in ('Demonstrou interesse','Pediu preço','Pediu proposta') then
    v_suggested := 'Quente';
  elsif p_result in ('Atendeu','Pediu retorno','Respondeu','Demo enviada') then
    v_suggested := case when v_current = 'Frio' then 'Morno' else v_current end;
  else
    v_suggested := v_current;
  end if;

  v_rank_cur := case v_current   when 'Quente' then 2 when 'Morno' then 1 else 0 end;
  v_rank_sug := case v_suggested when 'Quente' then 2 when 'Morno' then 1 else 0 end;
  v_final    := case when v_rank_sug > v_rank_cur then v_suggested else v_current end;

  insert into public.lead_interactions (id, lead_id, date, "user", channel, result, note)
  values ('i_' || gen_random_uuid()::text, p_lead_id, v_now, p_user, p_channel, p_result,
          coalesce(p_note, ''))
  returning jsonb_build_object(
    'id',      id,
    'lead_id', lead_id,
    'date',    date,
    'user',    "user",
    'channel', channel,
    'result',  result,
    'note',    note
  ) into v_inter;

  update public.leads
     set last_contact_at = v_now,
         temperature     = v_final,
         updated_at      = now()
   where id = p_lead_id;

  select to_jsonb(l) into v_lead from public.leads l where l.id = p_lead_id;

  return jsonb_build_object('interaction', v_inter, 'lead', v_lead);
end;
$$;

-- #################### FIM functions.sql ####################

-- #################### INICIO rls.sql ####################

-- ============================================================================
--  Sistema CRM - Row Level Security e permissões (Supabase / PostgreSQL)
--  Arquivo: backend/database/rls.sql
--  ---------------------------------------------------------------------------
--  MODELO DE ACESSO REAL DA APLICAÇÃO (por que não há policy para anon):
--
--    navegador  ->  front-end estático (file://)   NÃO fala com o Supabase
--    navegador  ->  API Express (localhost:3001)   service_role, só no servidor
--    API        ->  Supabase (service_role key)
--
--  Ou seja: NINGUÉM acessa o banco com a chave anon. Portanto:
--    * RLS fica HABILITADO em todas as tabelas;
--    * NÃO existe nenhuma policy para anon/authenticated => nega tudo
--      (deny-by-default). Nenhum "using (true)" é criado;
--    * apenas service_role (usado só pelo backend) acessa as tabelas, pois
--      esse papel faz bypass de RLS e recebe GRANT explícito abaixo.
--
--  Se um dia a autenticação for para o Supabase Auth, as policies por dono
--  (ex.: owner = auth.uid()) entram em uma migração nova (002_*.sql),
--  sem tocar neste arquivo.
--
--  Não apaga dados. Pode ser reexecutado.
--  Ordem de execução: schema.sql -> functions.sql -> rls.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) RLS habilitado em todas as tabelas (sem nenhuma policy permissiva)
-- ---------------------------------------------------------------------------
alter table public.users               enable row level security;
alter table public.leads               enable row level security;
alter table public.lead_status_history enable row level security;
alter table public.lead_interactions   enable row level security;
alter table public.lead_followups      enable row level security;
alter table public.agenda_events      enable row level security;
alter table public.lead_demos          enable row level security;
alter table public.lead_proposals      enable row level security;
alter table public.clients             enable row level security;
alter table public.client_updates      enable row level security;

-- ---------------------------------------------------------------------------
-- 2) Tira qualquer acesso de anon/authenticated e garante acesso ao backend
--    (o Supabase concede privilégios a anon/authenticated por padrão;
--     RLS sem policy já bloqueia, e o REVOKE é a segunda camada)
-- ---------------------------------------------------------------------------
revoke all on table public.users               from anon, authenticated;
revoke all on table public.leads               from anon, authenticated;
revoke all on table public.lead_status_history from anon, authenticated;
revoke all on table public.lead_interactions   from anon, authenticated;
revoke all on table public.lead_followups      from anon, authenticated;
revoke all on table public.agenda_events      from anon, authenticated;
revoke all on table public.lead_demos          from anon, authenticated;
revoke all on table public.lead_proposals      from anon, authenticated;
revoke all on table public.clients             from anon, authenticated;
revoke all on table public.client_updates      from anon, authenticated;

grant all on table public.users               to service_role;
grant all on table public.leads               to service_role;
grant all on table public.lead_status_history to service_role;
grant all on table public.lead_interactions   to service_role;
grant all on table public.lead_followups      to service_role;
grant all on table public.agenda_events      to service_role;
grant all on table public.lead_demos          to service_role;
grant all on table public.lead_proposals      to service_role;
grant all on table public.clients             to service_role;
grant all on table public.client_updates      to service_role;

-- ---------------------------------------------------------------------------
-- 3) Funções: no PostgreSQL, funções são executáveis por PUBLIC por padrão.
--    Fechamos isso e liberamos apenas para o backend.
--    (a assinatura precisa listar todos os parâmetros, inclusive os DEFAULT)
-- ---------------------------------------------------------------------------
revoke execute on function public.change_lead_status(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.add_lead_interaction(text, text, text, text, text) from public, anon, authenticated;

grant execute on function public.change_lead_status(text, text, text, text) to service_role;
grant execute on function public.add_lead_interaction(text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4) A função do trigger de updated_at também só existe para o backend.
--    (funções de trigger não podem ser chamadas diretamente, mas fecha-se
--     a permissão mesmo assim, por padrão de segurança)
-- ---------------------------------------------------------------------------
revoke execute on function public.set_updated_at() from public, anon, authenticated;
grant execute on function public.set_updated_at() to service_role;

-- #################### FIM rls.sql ####################

-- [parte 2] migrations/005_whatsapp_baileys.sql

-- Tabelas de persistência usadas pelo provider Baileys.
create table if not exists public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  contact_name text,
  company text,
  status text not null default 'Em atendimento',
  unread_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_conversations_updated_at
  on public.whatsapp_conversations(updated_at desc);

create table if not exists public.whatsapp_messages (
  id text primary key,
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  direction text not null check (direction in ('incoming', 'outgoing')),
  content text not null default '',
  timestamp timestamptz not null default now(),
  status text not null default 'sent',
  sent_by text,
  provider_message_id text,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_whatsapp_messages_provider_id
  on public.whatsapp_messages(provider_message_id)
  where provider_message_id is not null;
create index if not exists idx_whatsapp_messages_conversation_time
  on public.whatsapp_messages(conversation_id, timestamp);

alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_messages enable row level security;

revoke all on table public.whatsapp_conversations from anon, authenticated;
revoke all on table public.whatsapp_messages from anon, authenticated;
grant all on table public.whatsapp_conversations to service_role;
grant all on table public.whatsapp_messages to service_role;

-- [parte 3] migrations/014_financeiro.sql

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

-- ----------------------------------------------------------------------------
-- [parte 4] Os dois usuários do login. Sem linha em `users` o CRM responde
-- "Usuário não encontrado" e ninguém entra, porque a tela de entrada lista
-- Erick e Fabrício do front mas o login é conferido no banco
-- (backend/services/usersService.js: getUserAuth).
--
-- `do nothing`, e não `update`: se a pessoa já existe e já tem senha própria,
-- este script não derruba a senha dela. Com password_hash NULL vale a senha
-- inicial compartilhada do backend, e must_change_password (padrão true) força
-- a troca no primeiro acesso.
-- ----------------------------------------------------------------------------
insert into public.users (id, name, active)
  values ('erick', 'Erick', true),
         ('fabricio', 'Fabrício', true)
  on conflict (id) do nothing;

-- Conferência: mostra as tabelas criadas e o estado dos usuários.
select 'tabelas' as o_que, count(*) as quantidade
  from information_schema.tables
  where table_schema = 'public'
union all
select 'usuarios', count(*) from public.users
union all
select 'usuarios sem senha propria (usam a inicial)', count(*)
  from public.users where password_hash is null;

