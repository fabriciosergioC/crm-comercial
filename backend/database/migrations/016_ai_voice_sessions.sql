-- ============================================================================
--  Migração 016 - Assistente de voz com IA (sessões e mensagens)
--  Arquivo: backend/database/migrations/016_ai_voice_sessions.sql
--  ---------------------------------------------------------------------------
--  Cole no SQL Editor do Supabase e execute UMA vez. Nada aqui apaga tabela,
--  coluna ou linha existente: são duas tabelas novas, índices, RLS e o trigger
--  de updated_at (a função public.set_updated_at já existe desde a 001).
--
--  Por que tabelas novas e não reaproveitar lead_interactions:
--    lead_interactions guarda UM contato comercial (canal, resultado, nota de
--    até 1000 caracteres). A sessão de voz tem outro ciclo de vida: início,
--    fim, duração, status, transcrição inteira e cada mensagem em ordem. Tentar
--    espremer isso em "note" perderia dados e misturaria o histórico comercial
--    com rascunho de atendimento. O CRM continua usando lead_interactions como
--    sempre; quando o atendente autoriza, o encerramento grava TAMBÉM um
--    registro lá (canal Outro) — por escolha explícita na tela.
--
--  Idempotente: pode rodar de novo sem estragar nada.
-- ============================================================================

create table if not exists public.lead_ai_sessions (
  id                text        primary key,
  lead_id           text        not null references public.leads (id) on delete cascade,
  "user"            text        references public.users (id),
  status            text        not null default 'ativa'
                    check (status in ('ativa', 'encerrada', 'erro')),
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  duration_seconds  integer,
  transcript        text        not null default '',
  message_count     integer     not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint lai_duration_chk check (duration_seconds is null or duration_seconds >= 0),
  constraint lai_count_chk    check (message_count >= 0)
);

create index if not exists lead_ai_sessions_lead_idx on public.lead_ai_sessions (lead_id, started_at desc);
create index if not exists lead_ai_sessions_user_idx on public.lead_ai_sessions ("user");

alter table public.lead_ai_sessions enable row level security;
revoke all on table public.lead_ai_sessions from anon, authenticated;
grant all on table public.lead_ai_sessions to service_role;

drop trigger if exists lead_ai_sessions_set_updated_at on public.lead_ai_sessions;
create trigger lead_ai_sessions_set_updated_at
  before update on public.lead_ai_sessions
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- lead_ai_messages - cada fala do atendimento, na ordem em que aconteceu.
--   seq é a ordem estável (created_at pode empatar quando duas mensagens são
--   gravadas no mesmo milissegundo; nesse caso a leitura pelo created_at
--   poderia trocar a ordem da conversa).
-- ----------------------------------------------------------------------------
create table if not exists public.lead_ai_messages (
  id          text        primary key,
  session_id  text        not null references public.lead_ai_sessions (id) on delete cascade,
  role        text        not null check (role in ('assistant', 'user', 'system')),
  content     text        not null,
  created_at  timestamptz not null default now(),
  seq         bigserial   not null
);

create index if not exists lead_ai_messages_session_idx on public.lead_ai_messages (session_id, seq);

alter table public.lead_ai_messages enable row level security;
revoke all on table public.lead_ai_messages from anon, authenticated;
grant all on table public.lead_ai_messages to service_role;

-- Nada de DELETE automático: encerrar a sessão muda o status e preserva a
-- transcrição para consulta (mesma regra das outras tabelas do CRM).
