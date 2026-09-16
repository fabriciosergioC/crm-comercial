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
