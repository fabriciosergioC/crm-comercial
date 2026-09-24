-- ============================================================================
--  Sistema CRM - Funções (RPC) do banco (Supabase / PostgreSQL)
--  Arquivo: backend/database/functions.sql
--  ---------------------------------------------------------------------------
--  Estas duas funções existem porque as operações correspondentes no front-end
--  mudam DUAS coisas de uma vez e precisam ser atômicas:
--    1) change_lead_status .... muda o status E grava o histórico;
--    2) add_lead_interaction .. grava a interação E atualiza o lead
--                               (last_contact_at + temperatura).
--
--  Os nomes/tipos/formatos de retorno abaixo foram escritos para casar
--  EXATAMENTE com o que backend/services/leadsService.js já chama - portanto
--  os services existentes NÃO precisam ser alterados:
--
--    supabase.rpc('change_lead_status', { p_lead_id, p_to, p_user })
--      -> { lead, entry: { id, lead_id, from_status, to_status, date, user } }
--    supabase.rpc('add_lead_interaction',
--      { p_lead_id, p_user, p_channel, p_result, p_note })
--      -> { lead, interaction: { id, lead_id, date, user, channel, result, note } }
--
--  Não apaga nada. Pode ser reexecutado (CREATE OR REPLACE FUNCTION).
--  Ordem de execução: schema.sql -> functions.sql -> rls.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- change_lead_status - muda o status do lead e registra o histórico de forma
--   atômica. p_loss_reason é opcional (DEFAULT NULL), então a chamada atual do
--   service continua funcionando sem alteração.
-- ----------------------------------------------------------------------------
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
      'Novo','Contato pendente','MSG 1: Saudação','Contatado','Respondeu',
      'MSG 2: Apresentação','Demo enviada','Demo em análise','Interessado','Proposta enviada',
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
-- ----------------------------------------------------------------------------
-- add_lead_interaction - registra a interação e atualiza o lead
--   (last_contact_at + temperatura sugerida) de forma atômica.
--   A regra da temperatura é a MESMA do front-end (suggestTemperature) e de
--   backend/models/enums.js (TEMP_RANK / HOT_RESULTS / WARM_RESULTS):
--     * resultados "quentes" -> Quente
--     * resultados "mornos"  -> Morno (apenas se o lead estiver Frio)
--     * a temperatura SÓ SOBE, nunca desce.
-- ----------------------------------------------------------------------------
create or replace function public.add_lead_interaction(
  p_lead_id text,
  p_user    text,
  p_channel text,
  p_result  text,
  p_note    text default ''
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now       timestamptz := now();
  v_current   text;
  v_suggested text;
  v_final     text;
  v_rank_cur  integer;
  v_rank_sug  integer;
  v_lead      jsonb;
  v_inter     jsonb;
begin
  if p_channel is null or p_channel not in (
      'Ligação','WhatsApp','Instagram','E-mail','Presencial','Outro') then
    raise exception 'Canal inválido: %', p_channel using errcode = '22023';
  end if;

  if p_result is null or p_result not in (
      'Não atendeu','Atendeu','Pediu retorno','Respondeu','Demo enviada',
      'Demonstrou interesse','Pediu preço','Pediu proposta','Sem interesse',
      'Número inválido','Outro') then
    raise exception 'Resultado inválido: %', p_result using errcode = '22023';
  end if;

  select l.temperature into v_current
    from public.leads l
   where l.id = p_lead_id
     for update;

  if not found then
    raise exception 'Lead % não encontrado.', p_lead_id using errcode = 'P0002';
  end if;

  if p_result in ('Demonstrou interesse','Pediu preço','Pediu proposta') then
    v_suggested := 'Quente';
  elsif p_result in ('Atendeu','Pediu retorno','Respondeu','Demo enviada') then
    v_suggested := case when v_current = 'Frio' then 'Morno' else v_current end;
  else
    v_suggested := v_current;
  end if;

  v_rank_cur := case v_current   when 'Quente' then 2 when 'Morno' then 1 else 0 end;
  v_rank_sug := case v_suggested when 'Quente' then 2 when 'Morno' then 1 else 0 end;
  v_final    := case when v_rank_sug > v_rank_cur then v_suggested else v_current end;

  insert into public.lead_interactions (id, lead_id, date, "user", channel, result, note)
  values ('i_' || gen_random_uuid()::text, p_lead_id, v_now, p_user, p_channel, p_result,
          coalesce(p_note, ''))
  returning jsonb_build_object(
    'id',      id,
    'lead_id', lead_id,
    'date',    date,
    'user',    "user",
    'channel', channel,
    'result',  result,
    'note',    note
  ) into v_inter;

  update public.leads
     set last_contact_at = v_now,
         temperature     = v_final,
         updated_at      = now()
   where id = p_lead_id;

  select to_jsonb(l) into v_lead from public.leads l where l.id = p_lead_id;

  return jsonb_build_object('interaction', v_inter, 'lead', v_lead);
end;
$$;