-- Remove a etapa "Interessado" do funil.
-- Leads existentes nessa etapa voltam para "Contato pendente".

alter table public.leads drop constraint if exists leads_status_chk;

update public.leads
set status = 'Contato pendente', updated_at = now()
where status = 'Interessado';

alter table public.leads add constraint leads_status_chk check (status in (
  'Contato pendente','Proposta enviada','Negociação','Fechado','Perdido'
));

alter table public.lead_status_history drop constraint if exists lsh_from_chk;
alter table public.lead_status_history drop constraint if exists lsh_to_chk;

update public.lead_status_history
set from_status = 'Contato pendente'
where from_status = 'Interessado';

update public.lead_status_history
set to_status = 'Contato pendente'
where to_status = 'Interessado';

alter table public.lead_status_history add constraint lsh_from_chk check (
  from_status is null or from_status in (
    'Novo','Contato pendente','Contatado','Respondeu',
    'Demo enviada','Demo em análise','Proposta enviada',
    'Negociação','Fechado','Perdido'
  )
);

alter table public.lead_status_history add constraint lsh_to_chk check (
  to_status in (
    'Novo','Contato pendente','Contatado','Respondeu',
    'Demo enviada','Demo em análise','Proposta enviada',
    'Negociação','Fechado','Perdido'
  )
);

create or replace function public.change_lead_status(
  p_lead_id text,
  p_to text,
  p_user text default null,
  p_loss_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from text;
  v_lead jsonb;
  v_entry jsonb;
begin
  if p_to is null or p_to not in (
    'Contato pendente','Proposta enviada','Negociação','Fechado','Perdido'
  ) then
    raise exception 'Status inválido: %', p_to using errcode = '22023';
  end if;

  select l.status into v_from from public.leads l
  where l.id = p_lead_id for update;

  if v_from is null then
    raise exception 'Lead não encontrado: %', p_lead_id using errcode = 'P0002';
  end if;

  update public.leads
  set status = p_to,
      loss_reason = case
        when p_to = 'Perdido' and p_loss_reason is not null then p_loss_reason
        else loss_reason
      end,
      updated_at = now()
  where id = p_lead_id;

  insert into public.lead_status_history (id, lead_id, from_status, to_status, date, "user")
  values ('sh_' || gen_random_uuid()::text, p_lead_id, v_from, p_to, now(), p_user)
  returning jsonb_build_object(
    'id', id,
    'lead_id', lead_id,
    'from_status', from_status,
    'to_status', to_status,
    'date', date,
    'user', "user"
  ) into v_entry;

  select to_jsonb(l) into v_lead from public.leads l where l.id = p_lead_id;

  return jsonb_build_object('lead', v_lead, 'entry', v_entry);
end;
$$;
