create table if not exists public.agenda_events (
  id         text        primary key,
  type       text        not null check (type in ('reuniao','demonstracao','tarefa','compromisso')),
  title      text        not null,
  event_at   timestamptz not null,
  lead_id    text        references public.leads (id) on delete cascade,
  owner      text        references public.users (id),
  notes      text        not null default '',
  status     text        not null default 'agendado'
             check (status in ('agendado','concluido','cancelado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agenda_events_event_at_idx on public.agenda_events (event_at);
create index if not exists agenda_events_lead_id_idx on public.agenda_events (lead_id);

alter table public.agenda_events enable row level security;
revoke all on table public.agenda_events from anon, authenticated;
grant all on table public.agenda_events to service_role;

drop trigger if exists agenda_events_set_updated_at on public.agenda_events;
create trigger agenda_events_set_updated_at
  before update on public.agenda_events
  for each row execute function public.set_updated_at();
