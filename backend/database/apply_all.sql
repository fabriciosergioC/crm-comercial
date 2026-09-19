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
      'Novo','Contato pendente','Contatado','Respondeu','Demo enviada','Demo em análise',
      'Interessado','Proposta enviada','Negociação','Fechado','Perdido') then
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
revoke all on table public.lead_demos          from anon, authenticated;
revoke all on table public.lead_proposals      from anon, authenticated;
revoke all on table public.clients             from anon, authenticated;
revoke all on table public.client_updates      from anon, authenticated;

grant all on table public.users               to service_role;
grant all on table public.leads               to service_role;
grant all on table public.lead_status_history to service_role;
grant all on table public.lead_interactions   to service_role;
grant all on table public.lead_followups      to service_role;
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
