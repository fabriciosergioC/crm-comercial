-- Ciclo de vida da conversa de WhatsApp (o menu de status do chat).
--   🟡 Novo .................. cliente acabou de entrar em contato
--   🔵 Atendimento iniciado .. atendente está conversando com o cliente
--   🟣 Aguardando resposta ... atendente respondeu e espera o retorno
--   🟠 Aguardando atendente .. cliente respondeu e precisa de ação
--   🟢 Resolvido ............. atendimento concluído
--   🔴 Cancelado ............. encerrado sem solução
--   ⚫ Arquivado ............. encerrada e retirada da fila
--
-- Converte os rótulos antigos ("Em atendimento", "Aguardando cliente",
-- "Aguardando resposta") para o equivalente atual e qualquer valor fora do
-- ciclo para "Novo"; passa o padrão da coluna a "Novo".
-- Não apaga nada; pode ser reexecutado. A aplicação também normaliza na leitura
-- (backend/services/whatsapp/conversationStatus.js), então rodar isto é apenas
-- alinhar o dado persistido.
update public.whatsapp_conversations
   set status = case
     when status = 'Em atendimento' then 'Atendimento iniciado'
     when status = 'Aguardando cliente' then 'Aguardando resposta'
     when status in ('Novo', 'Atendimento iniciado', 'Aguardando resposta', 'Aguardando atendente', 'Resolvido', 'Cancelado', 'Arquivado') then status
     else 'Novo'
   end
 where status is distinct from case
     when status = 'Em atendimento' then 'Atendimento iniciado'
     when status = 'Aguardando cliente' then 'Aguardando resposta'
     when status in ('Novo', 'Atendimento iniciado', 'Aguardando resposta', 'Aguardando atendente', 'Resolvido', 'Cancelado', 'Arquivado') then status
     else 'Novo'
   end;

alter table public.whatsapp_conversations alter column status set default 'Novo';
