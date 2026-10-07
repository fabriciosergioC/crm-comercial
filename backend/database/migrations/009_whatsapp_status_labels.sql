-- Corrige a troca de rótulos da migração 008:
--   Respondido (antigo) -> Aguardando resposta
--   Aguardando atendente -> Respondido
-- Execute uma única vez, antes de voltar a gravar o status Respondido.
update public.whatsapp_conversations
   set status = case
     when status = 'Respondido' then 'Aguardando resposta'
     when status = 'Aguardando atendente' then 'Respondido'
   end
 where status in ('Respondido', 'Aguardando atendente');
