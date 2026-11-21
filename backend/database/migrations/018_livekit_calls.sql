-- ============================================================================
--  Migração 018 - Ligações para leads (LiveKit Cloud)
--  Arquivo: backend/database/migrations/018_livekit_calls.sql
--  ---------------------------------------------------------------------------
--  Guarda o histórico das ligações feitas pelo navegador. O token do link NÃO
--  fica no banco: ele expira em poucas horas e fica só no processo do backend.
--
--  Sem esta tabela o CRM continua ligando: o histórico cai para memória e a
--  tela avisa que a migration está pendente.
--
--  Idempotente: pode rodar de novo sem estragar nada.
-- ============================================================================

create table if not exists public.lead_calls (
  id               text        primary key,
  lead_id          text        not null references public.leads (id) on delete cascade,
  "user"           text,
  status           text        not null default 'ativa',
  room             text        not null,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  duration_seconds integer,
  expires_at       timestamptz,
  agent            boolean     not null default false,
  created_at       timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'lead_calls_status_chk'
      and conrelid = 'public.lead_calls'::regclass
  ) then
    alter table public.lead_calls
      add constraint lead_calls_status_chk check (status in ('ativa', 'encerrada'));
  end if;
end $$;

alter table public.lead_calls enable row level security;
revoke all on table public.lead_calls from anon, authenticated;
grant all on table public.lead_calls to service_role;

create index if not exists lead_calls_lead_started_idx
  on public.lead_calls (lead_id, started_at desc);
