-- ============================================================================
--  Migração 011 - apaga as etapas "MSG 1: Saudação" e "MSG 2: Apresentação"
--                  do funil de leads. NENHUM lead é removido: quem estava
--                  nelas passa para "Contatado".
--  Arquivo: backend/database/migrations/011_remove_msg_statuses.sql
--  ---------------------------------------------------------------------------
--  Delta:
--    1) update em public.leads (só nas linhas com os dois status extintos);
--    2) recria o CHECK leads_status_chk sem os dois valores;
--    3) recria a função change_lead_status com a lista nova (mesma do
--       backend/database/functions.sql e de backend/models/enums.js).
--
--  Os CHECKs de lead_status_history (lsh_from_chk / lsh_to_chk) ficam como
--  estão DE PROPÓSITO: eles ainda aceitam os rótulos antigos para não quebrar
--  o histórico já gravado ("Novo -> MSG 1: Saudação" continua legível). Se você
--  quiser sumir com esses rótulos também do histórico, rode o bloco OPCIONAL no
--  fim deste arquivo.
--
--  Como aplicar: cole TODO o conteúdo no SQL Editor do Supabase e RUN.
--  Depois reinicie o backend (feche a janela "Backend CRM - API" e rode o
--  run-crm.bat de novo) — backend/models/enums.js também mudou.
-- ============================================================================

begin;

-- 1) Os leads das duas etapas extintas vão para "Contatado" (mesma coluna do
--    funil, "Contato"). Nada é apagado.
update public.leads
   set status     = 'Contatado',
       updated_at = now()
 where status in ('MSG 1: Saudação', 'MSG 2: Apresentação');

-- 2) CHECK da tabela leads, sem as duas etapas.
alter table public.leads
  drop constraint if exists leads_status_chk,
  add constraint leads_status_chk check (status in (
    'Novo','Contato pendente','Contatado','Respondeu','Demo enviada',
    'Demo em análise','Interessado','Proposta enviada','Negociação',
    'Fechado','Perdido'));

-- 3) change_lead_status com a mesma lista (cópia exata de functions.sql).
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
      'Novo','Contato pendente','Contatado','Respondeu',
      'Demo enviada','Demo em análise','Interessado','Proposta enviada',
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

commit;

-- ============================================================================
--  OPCIONAL — só rode isto se você quiser que os rótulos "MSG 1: Saudação" e
--  "MSG 2: Apresentação" sumam TAMBÉM do histórico dos leads. Isso regrava o
--  passado dessas linhas (elas viram "Contatado"), então a trilha de auditoria
--  perde o detalhe de em qual mensagem cada lead estava.
-- ============================================================================
-- begin;
--
-- update public.lead_status_history
--    set from_status = 'Contatado'
--  where from_status in ('MSG 1: Saudação', 'MSG 2: Apresentação');
--
-- update public.lead_status_history
--    set to_status = 'Contatado'
--  where to_status in ('MSG 1: Saudação', 'MSG 2: Apresentação');
--
-- alter table public.lead_status_history
--   drop constraint if exists lsh_from_chk,
--   add constraint lsh_from_chk check (from_status is null or from_status in (
--     'Novo','Contato pendente','Contatado','Respondeu','Demo enviada',
--     'Demo em análise','Interessado','Proposta enviada','Negociação',
--     'Fechado','Perdido')),
--   drop constraint if exists lsh_to_chk,
--   add constraint lsh_to_chk check (to_status in (
--     'Novo','Contato pendente','Contatado','Respondeu','Demo enviada',
--     'Demo em análise','Interessado','Proposta enviada','Negociação',
--     'Fechado','Perdido'));
--
-- commit;
