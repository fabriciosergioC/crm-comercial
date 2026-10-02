-- Tabela isolada para não alterar a estrutura atual de leads.
-- Depois de validar o módulo, você pode criar a relação com a tabela
-- de leads existente usando a coluna lead_id.

create table if not exists public.lead_enrichments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid null,
  osm_id bigint null,
  osm_type text null,
  nome text,
  categoria text,
  telefone text,
  site text,
  email text,
  instagram text,
  facebook text,
  endereco text,
  cidade text,
  cep text,
  latitude numeric,
  longitude numeric,
  fonte text default 'OpenStreetMap',
  confianca_score integer,
  confianca_nivel text,
  validacao_site jsonb,
  dados_brutos jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_lead_enrichments_lead_id
  on public.lead_enrichments(lead_id);

create index if not exists idx_lead_enrichments_osm
  on public.lead_enrichments(osm_type, osm_id);
