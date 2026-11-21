-- ============================================================================
--  Migração 017 - Resposta automática da IA no WhatsApp
--  Arquivo: backend/database/migrations/017_ai_whatsapp_auto.sql
--  ---------------------------------------------------------------------------
--  Ligar/desligar o atendimento automático é uma decisão por lead: a IA só
--  responde no WhatsApp dos leads que tiverem enabled = true aqui. Sem linha
--  (ou com enabled = false) nada é enviado — o padrão continua sendo silêncio.
--
--  channel separa a sessão que nasceu no painel de voz da sessão que nasceu de
--  uma conversa automática de WhatsApp, para o histórico não misturar os dois.
--
--  Idempotente: pode rodar de novo sem estragar nada.
-- ============================================================================

create table if not exists public.lead_ai_whatsapp_auto (
  lead_id     text        primary key references public.leads (id) on delete cascade,
  enabled     boolean     not null default true,
  "user"      text        references public.users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.lead_ai_whatsapp_auto enable row level security;
revoke all on table public.lead_ai_whatsapp_auto from anon, authenticated;
grant all on table public.lead_ai_whatsapp_auto to service_role;

drop trigger if exists lead_ai_whatsapp_auto_set_updated_at on public.lead_ai_whatsapp_auto;
create trigger lead_ai_whatsapp_auto_set_updated_at
  before update on public.lead_ai_whatsapp_auto
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- lead_ai_sessions.channel - 'voz' (padrão, painel do lead) ou 'whatsapp'.
-- O check é criado fora do ADD COLUMN para a migração poder rodar de novo.
-- ----------------------------------------------------------------------------
alter table public.lead_ai_sessions add column if not exists channel text not null default 'voz';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'lead_ai_sessions_channel_chk'
      and conrelid = 'public.lead_ai_sessions'::regclass
  ) then
    alter table public.lead_ai_sessions
      add constraint lead_ai_sessions_channel_chk check (channel in ('voz', 'whatsapp'));
  end if;
end $$;

create index if not exists lead_ai_sessions_lead_channel_idx
  on public.lead_ai_sessions (lead_id, channel, started_at desc);
