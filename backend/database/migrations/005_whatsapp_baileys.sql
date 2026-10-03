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
