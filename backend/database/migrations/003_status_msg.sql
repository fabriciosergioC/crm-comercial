-- ============================================================================
--  Migração 003 - novos status de mensagem: "MSG 1: Saudação" e
--                  "MSG 2: Apresentação" (entre "Contato pendente" e "Contatado")
--  Arquivo: backend/database/migrations/003_status_msg.sql
--  ---------------------------------------------------------------------------
--  Delta: recria os CHECK de status (leads e lead_status_history) e a função
--  change_lead_status com a lista nova. Não apaga dados: apenas
--  DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT e CREATE OR REPLACE FUNCTION.
--
--  Como aplicar: cole TODO o conteúdo no SQL Editor do Supabase e RUN.
--  Depois reinicie o backend (backend/models/enums.js também foi atualizado).
-- ============================================================================

alter table public.leads
  drop constraint if exists leads_status_chk,
  add constraint leads_status_chk check (status in (
    'Novo','Contato pendente','MSG 1: Saudação','MSG 2: Apresentação','Contatado',
    'Respondeu','Demo enviada','Demo em análise','Interessado','Proposta enviada',
    'Negociação','Fechado','Perdido'));

alter table public.lead_status_history
  drop constraint if exists lsh_from_chk,
  add constraint lsh_from_chk check (from_status is null or from_status in (
    'Novo','Contato pendente','MSG 1: Saudação','MSG 2: Apresentação','Contatado',
    'Respondeu','Demo enviada','Demo em análise','Interessado','Proposta enviada',
    'Negociação','Fechado','Perdido')),
  drop constraint if exists lsh_to_chk,
  add constraint lsh_to_chk check (to_status in (
    'Novo','Contato pendente','MSG 1: Saudação','MSG 2: Apresentação','Contatado',
    'Respondeu','Demo enviada','Demo em análise','Interessado','Proposta enviada',
    'Negociação','Fechado','Perdido'));

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
      'Novo','Contato pendente','MSG 1: Saudação','MSG 2: Apresentação','Contatado',
      'Respondeu','Demo enviada','Demo em análise','Interessado','Proposta enviada',
      'Negociação','Fechado','Perdido') then
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
