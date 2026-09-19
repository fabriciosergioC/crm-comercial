-- ============================================================================
--  Migração 002 - autenticação de usuários
-- ============================================================================

alter table public.users
  add column if not exists password_hash text;

alter table public.users
  add column if not exists must_change_password boolean not null default true;

alter table public.users
  add column if not exists password_updated_at timestamptz;
