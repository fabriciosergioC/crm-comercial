-- ============================================================================
--  Migração 013 - tira "Demo enviada" e "Demo em análise" do funil comercial.
--                  NENHUM lead é apagado: os quatro que estavam nelas foram
--                  para "Interessado".
--  Arquivo: backend/database/migrations/013_remove_demo_statuses.sql
--  ---------------------------------------------------------------------------
--  O MOVIMENTO DE DADOS JÁ FOI FEITO PELO BACKEND em 12/10/2026 (4 leads, um
--  por um em POST /api/leads/:id/status), então cada linha foi para a etapa
--  certa e ficou registrada no histórico, igual quando você muda na tela.
--  O bloco 1 abaixo é só rede de segurança para o que entrou depois do snapshot.
--  Lista movida: Temp/rollback-status-demo-20261012.json
--                Temp/migracao-status-demo-20261012-relatorio.json
--
--  A DEMO NÃO SUMIU DO CRM: continua na aba Demonstrações (URL, validade,
--  visualizações, quem enviou) e continua sendo registrada como interação
--  "Demo enviada". O que deixou de existir é a ETAPA do funil — agora o funil
--  é Contato pendente -> Interessado -> Proposta enviada -> Negociação ->
--  Fechado / Perdido.
--
--  Delta:
--    1) update em public.leads (só nas linhas ainda com os dois rótulos);
--    2) recria o CHECK leads_status_chk sem os dois valores;
--    3) recria change_lead_status com a lista nova (mesma lista de
--       backend/database/functions.sql e de backend/models/enums.js).
--
--  Os CHECKs de lead_status_history (lsh_from_chk / lsh_to_chk) ficam como
--  estão DE PROPÓSITO: "Novo", "Contatado", "Respondeu", "Demo enviada" e
--  "Demo em análise" continuam aceitos no histórico para a trilha já gravada
--  ficar legível (e para o relatório de Desempenho continuar contando quem
--  recebeu demo antes de hoje). Se quiser apagar esses rótulos também do
--  histórico, rode o bloco OPCIONAL no fim do arquivo — isso regrava o passado.
--
--  Dependência: rode a 012 antes desta (a 013 assume o funil de 8 etapas que a
--  012 criou). Se ainda não rodou a 012, rode as duas na ordem, sem problema.
--
--  Como aplicar: cole TODO o conteúdo no SQL Editor do Supabase e RUN.
--  Depois reinicie o backend (feche a janela "Backend CRM - API" e rode o
--  run-crm.bat de novo) — backend/models/enums.js também mudou.
-- ============================================================================

begin;

-- 1) Rede de segurança: quem ainda estiver nas duas etapas extintas vai para
--    "Interessado". (12/10/2026: zero linhas atingidas, todas já migradas.)
update public.leads
   set status     = 'Interessado',
       updated_at = now()
 where status in ('Demo enviada', 'Demo em análise');

-- 2) CHECK da tabela leads, sem as duas etapas.
alter table public.leads
  drop constraint if exists leads_status_chk,
  add constraint leads_status_chk check (status in (
    'Contato pendente','Interessado','Proposta enviada','Negociação',
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
      'Contato pendente','Interessado','Proposta enviada','Negociação',
      'Fechado','Perdido') then
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
--  OPCIONAL — roda isto se "Demo enviada" e "Demo em análise" também devem
--  sumir do histórico. Além de regravar o passado, atenção: o relatório de
--  Desempenho usa esses rótulos para montar a escada, então as linhas antigas
--  deixariam de contar.
-- ============================================================================
-- begin;
--
-- update public.lead_status_history
--    set from_status = 'Interessado'
--  where from_status in ('Demo enviada', 'Demo em análise');
--
-- update public.lead_status_history
--    set to_status = 'Interessado'
--  where to_status in ('Demo enviada', 'Demo em análise');
--
-- alter table public.lead_status_history
--   drop constraint if exists lsh_from_chk,
--   add constraint lsh_from_chk check (from_status is null or from_status in (
--     'Contato pendente','Interessado','Proposta enviada','Negociação',
--     'Fechado','Perdido')),
--   drop constraint if exists lsh_to_chk,
--   add constraint lsh_to_chk check (to_status in (
--     'Contato pendente','Interessado','Proposta enviada','Negociação',
--     'Fechado','Perdido'));
--
-- commit;
