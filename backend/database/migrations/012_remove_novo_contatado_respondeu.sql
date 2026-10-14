-- ============================================================================
--  Migração 012 - tira "Novo", "Contatado" e "Respondeu" do funil comercial.
--                  NENHUM lead é apagado: os que estavam nessas três etapas
--                  foram movidos (Novo/Contatado -> "Contato pendente",
--                  Respondeu -> "Interessado").
--  Arquivo: backend/database/migrations/012_remove_novo_contatado_respondeu.sql
--  ---------------------------------------------------------------------------
--  O MOVIMENTO DE DADOS JÁ FOI FEITO PELO BACKEND em 12/10/2026 (17 leads,
--  um por um em POST /api/leads/:id/status), então cada linha foi para a etapa
--  certa E ficou registrada no histórico, igual quando você muda o status na
--  tela. O bloco 1 abaixo está aqui só como rede de segurança: se aparecer algum
--  lead que entrou pelo site enquanto mexíamos, ele ajusta e nada mais.
--  Lista nova: snapshot em Temp/rollback-status-20261012.json
--              relatório em Temp/migracao-status-20261012-relatorio.json
--
--  Delta:
--    1) update em public.leads (só nas linhas ainda com os três rótulos);
--    2) recria o CHECK leads_status_chk sem os três valores;
--    3) recria o default da coluna (lead novo nasce "Contato pendente");
--    4) recria change_lead_status com a lista nova (mesma lista de
--       backend/database/functions.sql e de backend/models/enums.js).
--
--  Os CHECKs de lead_status_history (lsh_from_chk / lsh_to_chk) ficam como
--  estão DE PROPÓSITO: eles ainda aceitam "Novo", "Contatado" e "Respondeu"
--  para não quebrar a trilha já gravada — "Novo -> Contato pendente" continua
--  legível, e o relatório de Desempenho ainda enxerga quem foi contatado antes
--  dessa mudança. Se você quiser apagar esses rótulos também do histórico, rode
--  o bloco OPCIONAL no fim do arquivo (isso regrava o passado).
--
--  Como aplicar: cole TODO o conteúdo no SQL Editor do Supabase e RUN.
--  Depois reinicie o backend (feche a janela "Backend CRM - API" e rode o
--  run-crm.bat de novo) — backend/models/enums.js também mudou.
-- ============================================================================

begin;

-- 1) Rede de segurança: quem ainda estiver nas três etapas extintas vai para a
--    etapa escolhida. (12/10/2026: zero linhas atingidas, todas já migradas.)
update public.leads
   set status     = 'Contato pendente',
       updated_at = now()
 where status in ('Novo', 'Contatado');

update public.leads
   set status     = 'Interessado',
       updated_at = now()
 where status = 'Respondeu';

-- 2) CHECK da tabela leads, sem as três etapas.
alter table public.leads
  drop constraint if exists leads_status_chk,
  add constraint leads_status_chk check (status in (
    'Contato pendente','Demo enviada','Demo em análise','Interessado',
    'Proposta enviada','Negociação','Fechado','Perdido'));

-- 3) Lead criado sem status explícito nasce "Contato pendente" (a primeira
--    etapa do funil novo). Sem isso o default antigo travaria no CHECK de cima.
alter table public.leads
  alter column status set default 'Contato pendente';

-- 4) change_lead_status com a mesma lista (cópia exata de functions.sql).
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
      'Contato pendente','Demo enviada','Demo em análise','Interessado',
      'Proposta enviada','Negociação','Fechado','Perdido') then
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
--  OPCIONAL — só rode isto se você quiser que "Novo", "Contatado" e "Respondeu"
--  sumam TAMBÉM do histórico dos leads. Isso regrava o passado dessas linhas,
--  então a trilha de auditoria perde o detalhe de em qual etapa cada lead
--  estava (e o relatório de Desempenho deixa de contar como "contato feito"
--  quem foi contatado antes de 12/10/2026 só pelo histórico).
-- ============================================================================
-- begin;
--
-- update public.lead_status_history
--    set from_status = 'Contato pendente'
--  where from_status in ('Novo', 'Contatado');
--
-- update public.lead_status_history
--    set from_status = 'Interessado'
--  where from_status = 'Respondeu';
--
-- update public.lead_status_history
--    set to_status = 'Contato pendente'
--  where to_status in ('Novo', 'Contatado');
--
-- update public.lead_status_history
--    set to_status = 'Interessado'
--  where to_status = 'Respondeu';
--
-- alter table public.lead_status_history
--   drop constraint if exists lsh_from_chk,
--   add constraint lsh_from_chk check (from_status is null or from_status in (
--     'Contato pendente','Demo enviada','Demo em análise','Interessado',
--     'Proposta enviada','Negociação','Fechado','Perdido')),
--   drop constraint if exists lsh_to_chk,
--   add constraint lsh_to_chk check (to_status in (
--     'Contato pendente','Demo enviada','Demo em análise','Interessado',
--     'Proposta enviada','Negociação','Fechado','Perdido'));
--
-- commit;
